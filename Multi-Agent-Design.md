# Multi-Agent System Design: Pi-Mono & Telegram

## 1. Executive Summary

This document outlines the architecture for a self-hosted, multi-agent system running on a local Linux machine. The system utilizes `pi-mono` (TypeScript coding agent) powered by Google Gemini (via API), accessible remotely via a Telegram Bot interface.

The system is designed with a "Micro-Agent" architecture, separating the "Dispatcher" (Chat interface) from specialized "Workers" (Finance and Visa monitors) to ensure stability, security, separation of concerns, and full observability.

## 2. Architecture Overview

The system runs as a "Pod" of 3 isolated Docker containers managed by Docker Compose.

```mermaid
graph TD
    User[User - Telegram] -->|Messages| Dispatcher

    subgraph "Docker Host (Laptop)"
        subgraph "Container 1: Dispatcher"
            Dispatcher[Node.js Telegram Bot]
            UsageGuard[Usage/Budget Controller]
            Cron[Master Scheduler]
            Router[Intent Router]
            JobQueue[Async Job Manager]
            CircuitBreaker[Circuit Breaker]
            SQLite[(SQLite DB)]
        end

        subgraph "Container 2: Finance Agent"
            FinAgent[Express.js + Gemini SDK]
            FinTools[Python: yfinance, matplotlib]
            FinHealth[/healthz endpoint]
        end

        subgraph "Container 3: Visa Agent"
            VisaAgent[Express.js + Gemini SDK]
            VisaTools[cheerio / Puppeteer fallback]
            VisaHealth[/healthz endpoint]
        end

        Dispatcher -->|HTTP + X-Service-Key| FinAgent
        Dispatcher -->|HTTP + X-Service-Key| VisaAgent
    end

    FinAgent -->|API| Gemini[Google Gemini API]
    VisaAgent -->|API| Gemini
    FinAgent -->|HTTPS| Stocks[Yahoo Finance]
    VisaAgent -->|HTTPS| VisaSite[Visa Appointments]
```

## 3. Project Structure

```
AgentsofAI/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── Multi-Agent-Design.md
├── packages/
│   ├── shared/                  # Shared types, auth, logger, health
│   │   ├── package.json
│   │   └── src/
│   │       ├── auth.ts          # X-Service-Key verification middleware
│   │       ├── logger.ts        # Pino structured logger factory
│   │       ├── health.ts        # Standard /healthz endpoint factory
│   │       └── types.ts         # Shared request/response interfaces
│   ├── dispatcher/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts         # Entry point, Telegraf bot
│   │       ├── router.ts        # Intent classification (command + LLM)
│   │       ├── jobs.ts          # Async job queue manager
│   │       ├── circuit.ts       # Circuit breaker per agent
│   │       ├── usage.ts         # UsageGuard (SQLite-backed)
│   │       ├── admin.ts         # /allow, /revoke, /usage, /status
│   │       ├── scheduler.ts     # node-cron + job integration
│   │       └── db.ts            # SQLite schema + migrations
│   ├── finance-agent/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts         # Express server
│   │       ├── executor.ts      # Python subprocess runner
│   │       └── gemini.ts        # Gemini API client
│   └── visa-agent/
│       ├── Dockerfile
│       ├── package.json
│       └── src/
│           ├── index.ts         # Express server
│           ├── scraper.ts       # cheerio + Puppeteer fallback
│           └── gemini.ts        # Gemini API client
└── data/                        # Docker volume mounts (gitignored)
    ├── dispatcher.sqlite
    ├── logs/                    # Rotated log archive
    ├── finance/
    └── visa/
```

## 4. Component Details

### 4.1 Container 1: The Dispatcher (Manager)

*   **Role:** The public face, gatekeeper, job orchestrator, and observability hub.
*   **Stack:** Node.js, Telegraf, better-sqlite3, pino, node-cron.
*   **Responsibilities:**
    *   **Auth:** Verifies Telegram User IDs against SQLite `allowed_users` table (hot-reloadable via `/allow` and `/revoke` commands).
    *   **Routing:** Intent Router classifies user messages. Commands (`/stock`, `/visa`) are matched first; unmatched messages fall back to a lightweight Gemini classification call (~100 tokens).
    *   **Async Jobs:** Every agent request creates a `jobs` row. The user receives an immediate "Working on it..." reply. Results are sent back when the job completes or fails.
    *   **Circuit Breaker:** Tracks consecutive failures per agent. After 3 failures in 5 minutes, the agent is marked "degraded" and requests are rejected with a user-friendly message. Auto-recovers when the next health check passes.
    *   **Scheduling:** `node-cron` triggers periodic jobs (e.g., visa slot checks). Each scheduled run creates a `jobs` row, with deduplication to skip if an identical job is already pending or running.
    *   **Budgeting:** `UsageGuard` reads/writes the SQLite `usage` table. Persists across restarts.
    *   **Observability:** Aggregates health from all agents via `/status` endpoint. Sends Telegram alerts to admin on failures and quota warnings.
*   **Resources:** Minimal (<100MB RAM).

#### 4.1.1 SQLite Schema

```sql
CREATE TABLE usage (
    date       TEXT PRIMARY KEY,   -- YYYY-MM-DD
    requests   INTEGER DEFAULT 0,
    tokens     INTEGER DEFAULT 0
);

CREATE TABLE jobs (
    id         TEXT PRIMARY KEY,   -- UUID v4
    agent      TEXT NOT NULL,      -- 'finance' | 'visa'
    payload    TEXT NOT NULL,      -- JSON request body
    status     TEXT DEFAULT 'pending', -- pending | running | done | failed
    result     TEXT,               -- JSON response or error message
    chat_id    INTEGER NOT NULL,   -- Telegram chat to reply to
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE allowed_users (
    telegram_id INTEGER PRIMARY KEY,
    added_at    TEXT DEFAULT (datetime('now'))
);
```

#### 4.1.2 Intent Router

| Input Pattern | Target | Method |
|---|---|---|
| `/stock <ticker>`, `/analyze`, `/portfolio` | Finance Agent | Command match |
| `/visa`, `/checkslots` | Visa Agent | Command match |
| `/allow`, `/revoke`, `/usage`, `/status`, `/help` | Dispatcher internal | Command match |
| Free-text message | Gemini classification | LLM fallback (~100 tokens) |

Unrouted messages are logged at `WARN` level for review.

#### 4.1.3 Async Job Lifecycle

```
User message
  → Router identifies agent
  → INSERT job (status: pending)
  → Reply "Working on it..."
  → POST to agent (timeout: 60s finance, 120s visa)
  → On success: UPDATE job (status: done), send result to Telegram
  → On timeout/error: UPDATE job (status: failed), notify user, increment circuit breaker
```

### 4.2 Container 2: Finance Agent (Analyst)

*   **Role:** Quantitative analysis and data visualization.
*   **Stack:** Express.js, `@google/generative-ai` SDK, Python 3.10+, `pandas`, `yfinance`, `matplotlib`, `numpy`.
*   **Endpoints:**
    *   `POST /task` — Accepts `{ prompt, context }`, returns `{ result, tokens_used, charts?: string[] }`.
    *   `GET /healthz` — Returns `{ status, uptime, memoryUsage }`.
*   **Execution Model:** Gemini generates Python code. The agent executes it via `child_process.execFile` with a 30s timeout in `/workspace/finance`. Charts are saved as PNGs and paths returned for the Dispatcher to send as Telegram photos.
*   **Sandbox:**
    *   Read-Only root filesystem.
    *   Isolated `/workspace/finance` volume (read-write).
    *   No access to Visa data.
    *   Egress restricted to: `generativelanguage.googleapis.com`, `query1.finance.yahoo.com`, `query2.finance.yahoo.com`.
*   **Resources:** Low to Moderate (~300MB RAM).

### 4.3 Container 3: Visa Agent (Concierge)

*   **Role:** Visa appointment slot monitoring.
*   **Stack:** Express.js, `@google/generative-ai` SDK, `cheerio` (primary), Puppeteer + Chromium (fallback for JS-rendered sites).
*   **Endpoints:**
    *   `POST /task` — Accepts `{ prompt, context }`, returns `{ result, tokens_used }`.
    *   `GET /healthz` — Returns `{ status, uptime, memoryUsage }`.
*   **Execution Model:** First attempts plain HTTP + `cheerio` parsing. Falls back to Puppeteer only if the target site requires JavaScript rendering. This reduces RAM from ~1GB to ~150MB in the common case.
*   **Sandbox:**
    *   Read-Only root filesystem.
    *   Isolated `/workspace/visa` volume (read-write).
    *   Egress restricted to: `generativelanguage.googleapis.com`, target visa appointment domain(s).
*   **Resources:** 150MB (cheerio mode) to 1GB (Puppeteer fallback).

## 5. Security & Authentication Model

### 5.1 User Authentication (External)

*   **Method:** **Telegram ID Whitelist** (SQLite-backed).
*   **Implementation:** The bot checks `msg.from.id` against the `allowed_users` table. Unauthorized attempts are logged at `WARN` level with the user's Telegram ID, username, and message text (truncated to 100 chars).
*   **Management:** Admin commands `/allow <id>` and `/revoke <id>` modify the whitelist without restart.

### 5.2 Service Authentication (Internal)

*   **Method:** **Private Docker Network + API Key Headers**.
*   **Implementation:**
    *   Agent containers only listen on the isolated Docker network (no host binding).
    *   Every HTTP request from Dispatcher to an Agent includes an `X-Service-Key` header.
    *   Each agent validates the key against its own `SERVICE_KEY` env var.
    *   Env vars: `SERVICE_KEY_FINANCE`, `SERVICE_KEY_VISA` (unique per agent).
*   **On failure:** Requests with missing or invalid keys are rejected with `401 Unauthorized` and logged at `ERROR` level.

### 5.3 System Security (Docker)

*   **User Mapping:** All processes run as `node` or `appuser` (UID 1000), **never** `root`.
*   **Filesystem:**
    *   Root (`/`) is Read-Only (`read_only: true` in compose).
    *   `/tmp` mounted as `tmpfs` (ephemeral, not persisted).
    *   Specific `/workspace` volume is Read-Write.
*   **Capabilities:**
    *   All capabilities dropped: `cap_drop: [ALL]`.
    *   `security_opt: [no-new-privileges:true]`.
    *   Default `seccomp` profile applied.
*   **Network:**
    *   Dispatcher: Connected to both `public` (internet) and `internal` (inter-container) networks.
    *   Agents: Connected to `internal` network only. Outbound internet access restricted to allowlisted domains via egress proxy.
*   **API Keys:** Separate Gemini API keys per container. Compromise of one agent does not expose another agent's key.

### 5.4 Egress Filtering

*   **Method:** Lightweight forward proxy (`tinyproxy`) or iptables rules on the Docker host.
*   **Allowlists:**
    *   Finance Agent: `generativelanguage.googleapis.com`, `query1.finance.yahoo.com`, `query2.finance.yahoo.com`
    *   Visa Agent: `generativelanguage.googleapis.com`, `<visa-domain>`
    *   Dispatcher: `api.telegram.org`, `generativelanguage.googleapis.com`
*   **All other outbound traffic is dropped and logged.**

## 6. Usage & Budget Control

*   **Module:** `UsageGuard` inside Dispatcher, backed by SQLite `usage` table.
*   **Policy:**
    *   Daily Request Limit: 50 requests/day (configurable via env).
    *   Token Limit: 1M tokens/day (configurable via env).
*   **Actions:**
    *   If limit exceeded: Dispatcher replies "Quota Exceeded" and refuses to forward.
    *   At 80% quota: Dispatcher sends a one-time warning to the admin user.
*   **Visibility:** `/usage` command returns current day's consumption and remaining quota.
*   **Persistence:** Survives container restarts. Resets daily at midnight UTC.

## 7. Logging & Observability

### 7.1 Logging Framework

*   **Library:** `pino` (high-performance structured JSON logger for Node.js).
*   **Format:** JSON lines to stdout. Each log line is a self-contained JSON object.
*   **Configuration:** Created via shared factory in `packages/shared/src/logger.ts`.

#### 7.1.1 Standard Log Fields (Every Line)

Every log entry includes these base fields automatically:

| Field | Type | Description | Example |
|---|---|---|---|
| `timestamp` | ISO 8601 string | When the event occurred | `"2026-02-09T14:32:01.123Z"` |
| `level` | string | Log severity | `"info"`, `"warn"`, `"error"` |
| `service` | string | Container/service name | `"dispatcher"`, `"finance-agent"`, `"visa-agent"` |
| `hostname` | string | Container hostname | `"dispatcher-abc123"` |
| `pid` | number | Process ID | `1` |
| `msg` | string | Human-readable message | `"Job completed"` |

#### 7.1.2 Log Levels

| Level | When to Use | Examples |
|---|---|---|
| `fatal` | Process cannot continue, will exit | Uncaught exception, DB file corrupt, missing required env vars |
| `error` | Operation failed, needs attention | Agent HTTP call failed, Gemini API returned 500, service key rejected |
| `warn` | Unexpected but recoverable | Unauthorized Telegram user, unrouted message, quota at 80%, circuit breaker tripped |
| `info` | Normal operations worth recording | Job created, job completed, agent health check passed, user authenticated, cron triggered |
| `debug` | Detailed diagnostic data | Full HTTP request/response payloads, router decision reasoning, SQL queries executed |
| `trace` | Extremely verbose | Pino internal, raw Telegram update objects |

*   **Production default:** `info` (configurable via `LOG_LEVEL` env var per container).
*   **Debug mode:** Set `LOG_LEVEL=debug` on any container without rebuild.

#### 7.1.3 Contextual Log Fields by Event Type

**Telegram Events (Dispatcher):**
```json
{
  "timestamp": "2026-02-09T14:32:01.123Z",
  "level": "info",
  "service": "dispatcher",
  "msg": "Incoming message routed",
  "event": "telegram.message",
  "telegram_user_id": 123456789,
  "chat_id": 123456789,
  "route_target": "finance",
  "route_method": "command_match",
  "command": "/stock",
  "args": "AAPL"
}
```

**Auth Events (Dispatcher):**
```json
{
  "level": "warn",
  "service": "dispatcher",
  "msg": "Unauthorized access attempt",
  "event": "auth.rejected",
  "telegram_user_id": 987654321,
  "telegram_username": "unknown_user",
  "message_preview": "hey can you help me..."
}
```

**Job Lifecycle (Dispatcher):**
```json
{
  "level": "info",
  "service": "dispatcher",
  "msg": "Job completed",
  "event": "job.done",
  "job_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "agent": "finance",
  "duration_ms": 4523,
  "tokens_used": 1250,
  "chat_id": 123456789
}
```

```json
{
  "level": "error",
  "service": "dispatcher",
  "msg": "Job failed",
  "event": "job.failed",
  "job_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "agent": "visa",
  "duration_ms": 120000,
  "error": "Request timeout after 120000ms",
  "chat_id": 123456789
}
```

**Usage/Quota Events (Dispatcher):**
```json
{
  "level": "warn",
  "service": "dispatcher",
  "msg": "Daily quota warning",
  "event": "usage.warning",
  "date": "2026-02-09",
  "requests_used": 40,
  "requests_limit": 50,
  "tokens_used": 820000,
  "tokens_limit": 1000000,
  "percent_requests": 80,
  "percent_tokens": 82
}
```

**Circuit Breaker Events (Dispatcher):**
```json
{
  "level": "warn",
  "service": "dispatcher",
  "msg": "Circuit breaker tripped",
  "event": "circuit.open",
  "agent": "visa",
  "consecutive_failures": 3,
  "last_error": "Connection refused",
  "cooldown_seconds": 300
}
```

```json
{
  "level": "info",
  "service": "dispatcher",
  "msg": "Circuit breaker recovered",
  "event": "circuit.closed",
  "agent": "visa",
  "downtime_seconds": 312
}
```

**Agent Task Events (Finance/Visa Agents):**
```json
{
  "level": "info",
  "service": "finance-agent",
  "msg": "Task received",
  "event": "task.received",
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "prompt_length": 245
}
```

```json
{
  "level": "info",
  "service": "finance-agent",
  "msg": "Gemini API call completed",
  "event": "gemini.response",
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "model": "gemini-2.0-flash",
  "input_tokens": 300,
  "output_tokens": 950,
  "latency_ms": 2103
}
```

```json
{
  "level": "info",
  "service": "finance-agent",
  "msg": "Python execution completed",
  "event": "python.exec",
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "exit_code": 0,
  "duration_ms": 1200,
  "output_files": ["/workspace/finance/output/AAPL_chart.png"]
}
```

```json
{
  "level": "error",
  "service": "finance-agent",
  "msg": "Python execution failed",
  "event": "python.exec",
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "exit_code": 1,
  "duration_ms": 502,
  "stderr": "ModuleNotFoundError: No module named 'sklearn'"
}
```

**Health Check Events (All Containers):**
```json
{
  "level": "info",
  "service": "dispatcher",
  "msg": "Agent health check",
  "event": "health.check",
  "agent": "finance",
  "status": "healthy",
  "response_time_ms": 12,
  "agent_uptime_seconds": 86400,
  "agent_memory_mb": 245
}
```

**Service Auth Events (Agents):**
```json
{
  "level": "error",
  "service": "finance-agent",
  "msg": "Invalid service key",
  "event": "auth.service_rejected",
  "remote_ip": "172.18.0.2",
  "path": "/task"
}
```

**Egress Block Events (Proxy/Firewall):**
```json
{
  "level": "warn",
  "service": "finance-agent",
  "msg": "Outbound request blocked by egress filter",
  "event": "egress.blocked",
  "target_host": "evil.example.com",
  "target_port": 443
}
```

#### 7.1.4 Request Correlation

All log entries for a single user request share a `request_id` (UUID v4), set as the `job_id` by the Dispatcher and forwarded to agents via the `X-Request-ID` HTTP header. This enables tracing a request across all containers:

```bash
# Trace a single request across all containers
docker compose logs | jq 'select(.request_id == "f47ac10b-...")'
```

### 7.2 Log Collection & Rotation

*   **Docker Driver:** `json-file` with rotation.

```yaml
# Applied to every service in docker-compose.yml
logging:
  driver: json-file
  options:
    max-size: "10m"    # Rotate at 10MB per file
    max-file: "5"      # Keep 5 rotated files (50MB max per container)
```

*   **Total disk budget:** 3 containers x 50MB = **150MB max** for logs.
*   **Log location on host:** Docker default (`/var/lib/docker/containers/<id>/<id>-json.log`).
*   **Optional archive:** A weekly cron job on the host compresses and moves logs older than 7 days to `data/logs/archive/`.

### 7.3 Log Querying

Since all logs are structured JSON, they can be queried with standard tools:

```bash
# All errors across all containers in the last hour
docker compose logs --since 1h | jq 'select(.level == "error")'

# Finance agent Gemini API latencies
docker compose logs finance-agent | jq 'select(.event == "gemini.response") | {time: .timestamp, ms: .latency_ms}'

# All jobs that took longer than 10 seconds
docker compose logs dispatcher | jq 'select(.event == "job.done" and .duration_ms > 10000)'

# Daily token consumption
docker compose logs dispatcher | jq 'select(.event == "job.done") | .tokens_used' | paste -sd+ | bc

# All unauthorized access attempts
docker compose logs dispatcher | jq 'select(.event == "auth.rejected")'

# Trace a full request lifecycle
export RID="f47ac10b-58cc-4372-a567-0e02b2c3d479"
docker compose logs | jq "select(.request_id == \"$RID\")" | jq -s 'sort_by(.timestamp)'
```

### 7.4 Health Checks & Self-Monitoring

*   **Health Endpoint:** Every container exposes `GET /healthz` returning:

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "memory_usage_mb": 78,
  "version": "1.0.0"
}
```

*   **Docker Health Checks:** Configured in `docker-compose.yml`:

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

*   **Dispatcher `/status` Command:** Returns aggregated system health to Telegram:

```
System Status:
  Dispatcher: healthy (uptime: 2d 4h, mem: 78MB)
  Finance Agent: healthy (uptime: 2d 4h, mem: 245MB)
  Visa Agent: degraded (circuit open, 3 failures)
  Quota: 32/50 requests, 640K/1M tokens
```

### 7.5 Telegram Alerts

The Dispatcher proactively sends Telegram messages to the admin user when:

| Trigger | Severity | Message |
|---|---|---|
| Agent fails health check 3x consecutively | High | "Finance Agent is DOWN. Circuit breaker activated." |
| Circuit breaker recovers | Info | "Finance Agent is back online (downtime: 5m 12s)." |
| Daily quota exceeds 80% | Medium | "Quota warning: 80% consumed (40/50 requests, 820K/1M tokens)." |
| Daily quota exceeded | High | "Quota exceeded. All agent requests blocked until midnight UTC." |
| Job stuck for >5 minutes | Medium | "Job f47ac... (visa) has been running for 5+ minutes. May be stuck." |
| Unauthorized access attempt | Low | "Blocked message from unknown user 987654321 (@username)." |

### 7.6 Sensitive Data Policy

The following data is **never logged**, even at `debug` level:

*   Gemini API keys or service keys (masked as `"gm-****"` if referenced).
*   Full user message content (truncated to 100 chars in `message_preview`).
*   Gemini API response bodies (only metadata: token counts, latency).
*   Python script output containing potential financial data (only exit code and file paths).

## 8. Resilience

### 8.1 Restart Policies

All containers use `restart: on-failure` with a maximum of 5 retries. Docker health checks trigger restarts for unhealthy containers.

### 8.2 Circuit Breaker (per Agent)

| State | Condition | Behavior |
|---|---|---|
| **Closed** (normal) | Fewer than 3 failures in 5 min | Requests forwarded normally |
| **Open** (tripped) | 3+ consecutive failures in 5 min | Requests rejected immediately, user notified, alert sent |
| **Half-Open** (probing) | After cooldown (5 min) | Next health check success closes the circuit; failure reopens it |

### 8.3 Timeouts

| Operation | Timeout |
|---|---|
| Finance Agent HTTP call | 60 seconds |
| Visa Agent HTTP call | 120 seconds |
| Python subprocess execution | 30 seconds |
| Gemini API call | 30 seconds |
| Health check | 5 seconds |

## 9. Docker Compose Configuration

```yaml
services:
  dispatcher:
    build: ./packages/dispatcher
    restart: "on-failure:5"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - GEMINI_API_KEY=${GEMINI_API_KEY_DISPATCHER}
      - SERVICE_KEY_FINANCE=${SERVICE_KEY_FINANCE}
      - SERVICE_KEY_VISA=${SERVICE_KEY_VISA}
      - ADMIN_TELEGRAM_ID=${ADMIN_TELEGRAM_ID}
      - LOG_LEVEL=info
      - DAILY_REQUEST_LIMIT=50
      - DAILY_TOKEN_LIMIT=1000000
    volumes:
      - ./data/dispatcher.sqlite:/app/data/db.sqlite
    networks:
      - public
      - internal
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    security_opt:
      - no-new-privileges:true

  finance-agent:
    build: ./packages/finance-agent
    restart: "on-failure:5"
    read_only: true
    tmpfs:
      - /tmp
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    environment:
      - SERVICE_KEY=${SERVICE_KEY_FINANCE}
      - GEMINI_API_KEY=${GEMINI_API_KEY_FINANCE}
      - LOG_LEVEL=info
    volumes:
      - ./data/finance:/workspace/finance
    networks:
      - internal
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

  visa-agent:
    build: ./packages/visa-agent
    restart: "on-failure:5"
    read_only: true
    tmpfs:
      - /tmp
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3002/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    environment:
      - SERVICE_KEY=${SERVICE_KEY_VISA}
      - GEMINI_API_KEY=${GEMINI_API_KEY_VISA}
      - LOG_LEVEL=info
    volumes:
      - ./data/visa:/workspace/visa
    networks:
      - internal
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

networks:
  public:
    driver: bridge
  internal:
    driver: bridge
    internal: true
```

## 10. Hardware Requirements

*   **OS:** Linux (Recommended).
*   **RAM:** Minimum 4GB, Recommended 8GB+.
*   **CPU:** Dual-Core or better.
*   **Storage:** ~5GB (Docker images) + 150MB (logs) + workspace data.

## 11. Environment Variables

```bash
# .env.example

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
ADMIN_TELEGRAM_ID=your-telegram-user-id

# Gemini API Keys (one per service for isolation)
GEMINI_API_KEY_DISPATCHER=key-for-dispatcher
GEMINI_API_KEY_FINANCE=key-for-finance-agent
GEMINI_API_KEY_VISA=key-for-visa-agent

# Inter-Service Auth (generate with: openssl rand -hex 32)
SERVICE_KEY_FINANCE=random-64-char-hex-string
SERVICE_KEY_VISA=random-64-char-hex-string

# Quotas
DAILY_REQUEST_LIMIT=50
DAILY_TOKEN_LIMIT=1000000

# Logging
LOG_LEVEL=info   # fatal | error | warn | info | debug | trace
```

## 12. Implementation Roadmap

### Phase 0: Scaffolding
1.  Initialize npm workspaces monorepo with `packages/shared`, `packages/dispatcher`, `packages/finance-agent`, `packages/visa-agent`.
2.  Create `.env.example`, `.gitignore`, TypeScript configs.
3.  Create `data/` directory structure.

### Phase 1: Shared Package
4.  Implement `logger.ts` — pino factory with standard fields, child logger support, sensitive data redaction.
5.  Implement `auth.ts` — Express middleware validating `X-Service-Key` header.
6.  Implement `health.ts` — `/healthz` endpoint factory returning uptime, memory, version.
7.  Define `types.ts` — `TaskRequest`, `TaskResponse`, `HealthResponse`, `JobStatus` interfaces.

### Phase 2: Dispatcher Core
8.  Implement `db.ts` — SQLite connection, schema creation, migrations.
9.  Implement `usage.ts` — `UsageGuard` reading/writing `usage` table, quota checks, 80% warning trigger.
10. Implement `router.ts` — command-match first, Gemini LLM fallback for free-text.
11. Implement `jobs.ts` — job creation, status updates, timeout enforcement, result delivery.
12. Implement `circuit.ts` — circuit breaker state machine (closed/open/half-open) per agent.
13. Implement `scheduler.ts` — `node-cron` schedules that create job rows with deduplication.
14. Implement `admin.ts` — `/allow`, `/revoke`, `/usage`, `/status` Telegram command handlers.
15. Implement `index.ts` — Telegraf bot setup, middleware chain (auth → usage → router → jobs).

### Phase 3: Agents (parallelizable with Phase 2 steps 10-15)
16. Implement Finance Agent `index.ts` — Express server with `/task` and `/healthz`.
17. Implement Finance Agent `gemini.ts` — Gemini SDK wrapper with token counting and logging.
18. Implement Finance Agent `executor.ts` — Python subprocess runner with timeout, exit code, and output file capture.
19. Implement Visa Agent `index.ts` — Express server with `/task` and `/healthz`.
20. Implement Visa Agent `scraper.ts` — cheerio-first scraper with Puppeteer fallback detection.
21. Implement Visa Agent `gemini.ts` — Gemini SDK wrapper (same pattern as Finance).

### Phase 4: Dockerization
22. Write `Dockerfile` for Dispatcher (Node.js + SQLite).
23. Write `Dockerfile` for Finance Agent (Node.js + Python 3.10 + pip packages).
24. Write `Dockerfile` for Visa Agent (Node.js + Chromium + Puppeteer).
25. Write `docker-compose.yml` with networks, health checks, security, logging, volumes.

### Phase 5: Security Hardening
26. Configure egress allowlists (tinyproxy or iptables rules).
27. Verify `read_only`, `cap_drop`, `no-new-privileges`, `seccomp` on all containers.
28. Generate and configure per-service API keys and service keys.
29. Test: unauthorized Telegram user blocked, invalid service key rejected, egress to non-allowlisted domain dropped.

### Phase 6: Observability & Alerts
30. Implement Telegram alert sender for admin notifications (health failures, quota warnings, stuck jobs).
31. Implement `/status` aggregation endpoint in Dispatcher.
32. Set up optional host-level cron for weekly log archival to `data/logs/archive/`.
33. End-to-end test: send a `/stock AAPL` command, trace the full request lifecycle across all logs using `request_id`.

### Dependency Graph

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6
                    └──→ Phase 3 ──┘
```

Phases 2 and 3 can be developed in parallel since both depend only on Phase 1 (shared package).
