# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AgentsofAI** is a self-hosted multi-agent system that runs as a "Pod" of 3 isolated Docker containers. The system exposes AI capabilities through a Telegram Bot interface, powered by Google Gemini API. It follows a "Micro-Agent" architecture with a central Dispatcher and specialized Worker agents.

## Architecture

### Container Structure
1. **Dispatcher (Manager)** - Telegram bot, routing, auth, scheduling, circuit breaking
2. **Finance Agent (Worker)** - Quantitative analysis using Python (yfinance, matplotlib)
3. **Visa Agent (Worker)** - Web scraping for visa appointment monitoring

### Key Design Principles
- **Stateful Dispatcher, Stateless Workers**: Only the Dispatcher maintains state (SQLite). Agents are pure workers.
- **Async Job Queue**: Every user request creates a job row. Users get immediate "Working on it..." replies. Results delivered when complete.
- **Circuit Breaker Pattern**: 3 consecutive failures trip the circuit. Auto-recovers on next successful health check.
- **Request Tracing**: All operations for a single request share a `request_id` (UUID v4) for end-to-end tracing across containers.

### Communication Flow
```
Telegram User → Dispatcher (auth + routing) → Agent (HTTP + X-Service-Key) → Gemini API
                    ↓
                SQLite (jobs, usage, allowed_users)
```

## NPM Workspaces Monorepo Structure

```
packages/
├── shared/          # Common utilities (logger, auth middleware, types, health endpoint)
├── dispatcher/      # Telegram bot, router, jobs queue, circuit breaker, scheduler
├── finance-agent/   # Express API + Gemini + Python subprocess executor
└── visa-agent/      # Express API + Gemini + cheerio/Puppeteer scraper
```

## Development Commands

**Note**: The codebase is currently in the design phase. Once implemented, use:

```bash
# Start all services
docker compose up -d

# View logs (structured JSON via pino)
docker compose logs -f

# View logs for specific service
docker compose logs -f dispatcher
docker compose logs -f finance-agent

# Trace a single request across all containers
export RID="<request-id-uuid>"
docker compose logs | jq "select(.request_id == \"$RID\")" | jq -s 'sort_by(.timestamp)'

# Query logs (all errors in last hour)
docker compose logs --since 1h | jq 'select(.level == "error")'

# Stop all services
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Check container health
docker compose ps
```

## Telegram Bot Commands (Runtime)

- `/stock <ticker>` - Finance agent analysis
- `/visa` - Check visa appointment slots
- `/allow <telegram_id>` - Add user to whitelist (admin only)
- `/revoke <telegram_id>` - Remove user from whitelist (admin only)
- `/usage` - View current quota consumption
- `/status` - System health check across all agents
- `/help` - Show available commands

## Environment Configuration

Required environment variables (see `.env.example`):

```bash
# Telegram
TELEGRAM_BOT_TOKEN=          # From @BotFather
ADMIN_TELEGRAM_ID=           # Your Telegram user ID

# Gemini API Keys (separate per service for isolation)
GEMINI_API_KEY_DISPATCHER=
GEMINI_API_KEY_FINANCE=
GEMINI_API_KEY_VISA=

# Inter-Service Authentication (generate with: openssl rand -hex 32)
SERVICE_KEY_FINANCE=
SERVICE_KEY_VISA=

# Quotas
DAILY_REQUEST_LIMIT=50
DAILY_TOKEN_LIMIT=1000000

# Logging
LOG_LEVEL=info              # fatal | error | warn | info | debug | trace
```

## Security Architecture

### Authentication Layers
1. **External (Telegram)**: User ID whitelist in SQLite `allowed_users` table. Managed via `/allow` and `/revoke` commands.
2. **Internal (Service-to-Service)**: `X-Service-Key` header validated by agents. Each agent has a unique key.

### Container Isolation
- Root filesystem is **read-only** (`read_only: true`)
- `/tmp` mounted as ephemeral `tmpfs`
- Only `/workspace/<agent>` is writable
- All Linux capabilities dropped (`cap_drop: [ALL]`)
- Processes run as non-root (UID 1000)
- `no-new-privileges` and default `seccomp` enabled

### Network Isolation
- **Dispatcher**: Connected to both `public` (internet) and `internal` (inter-container) networks
- **Agents**: Connected to `internal` network only
- Egress filtering restricts agents to allowlisted domains only (Gemini API + data sources)

### Sensitive Data Policy
Never log in any circumstance:
- API keys or service keys (mask as `"gm-****"`)
- Full user messages (truncate to 100 chars in `message_preview`)
- Gemini API response bodies (log only metadata: tokens, latency)
- Python script output containing financial data (log only exit codes and file paths)

## Observability

### Structured Logging (Pino)
All logs are JSON with standard fields:
- `timestamp`, `level`, `service`, `msg`
- `request_id` - UUID v4 for tracing across containers
- `event` - Structured event type (e.g., `job.done`, `auth.rejected`, `circuit.open`)

### Key Event Types
- `telegram.message` - Incoming user message routed
- `auth.rejected` - Unauthorized access attempt
- `job.done` / `job.failed` - Job lifecycle
- `usage.warning` - Quota at 80%
- `circuit.open` / `circuit.closed` - Circuit breaker state changes
- `gemini.response` - Gemini API call completed
- `python.exec` - Python subprocess execution

### Health Checks
Every container exposes `GET /healthz`:
```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "memory_usage_mb": 78,
  "version": "1.0.0"
}
```

Docker health checks configured with 30s interval, 5s timeout, 3 retries.

### Telegram Alerts
Dispatcher proactively sends admin alerts for:
- Agent health check failures (3x consecutive)
- Circuit breaker trips and recoveries
- Quota warnings (80% threshold) and exceeded
- Jobs stuck for >5 minutes
- Unauthorized access attempts

## Dispatcher SQLite Schema

```sql
-- Daily quota tracking (persists across restarts)
CREATE TABLE usage (
    date       TEXT PRIMARY KEY,   -- YYYY-MM-DD
    requests   INTEGER DEFAULT 0,
    tokens     INTEGER DEFAULT 0
);

-- Async job queue
CREATE TABLE jobs (
    id         TEXT PRIMARY KEY,   -- UUID v4
    agent      TEXT NOT NULL,      -- 'finance' | 'visa'
    payload    TEXT NOT NULL,      -- JSON request body
    status     TEXT DEFAULT 'pending', -- pending | running | done | failed
    result     TEXT,               -- JSON response or error
    chat_id    INTEGER NOT NULL,   -- Telegram chat to reply to
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

-- User authorization
CREATE TABLE allowed_users (
    telegram_id INTEGER PRIMARY KEY,
    added_at    TEXT DEFAULT (datetime('now'))
);
```

## Implementation Phases

The system is designed to be implemented in phases (see Multi-Agent-Design.md for full details):

1. **Phase 0**: Scaffolding (monorepo setup, config files)
2. **Phase 1**: Shared package (logger, auth middleware, health endpoint, types)
3. **Phase 2**: Dispatcher core (Telegram bot, router, jobs queue, circuit breaker, admin commands)
4. **Phase 3**: Agents (Finance and Visa worker services) - Can parallelize with Phase 2
5. **Phase 4**: Dockerization (Dockerfiles, docker-compose.yml)
6. **Phase 5**: Security hardening (egress filtering, permission verification)
7. **Phase 6**: Observability (Telegram alerts, status aggregation, log archival)

Phases 2 and 3 can be developed concurrently as they only depend on Phase 1.

## Resilience & Timeouts

### Circuit Breaker States
- **Closed** (normal): <3 failures in 5 min → forward requests
- **Open** (tripped): ≥3 failures in 5 min → reject immediately, send alert
- **Half-Open** (probing): After 5 min cooldown → test with next health check

### Operation Timeouts
- Finance Agent HTTP call: 60s
- Visa Agent HTTP call: 120s
- Python subprocess: 30s
- Gemini API call: 30s
- Health check: 5s

### Restart Policy
All containers: `on-failure:5` (max 5 restart attempts)

## Agent-Specific Details

### Finance Agent
- Gemini generates Python code → executed via `child_process.execFile` in isolated `/workspace/finance`
- Charts saved as PNGs, paths returned to Dispatcher for Telegram photo upload
- Python stack: pandas, yfinance, matplotlib, numpy
- Egress: `generativelanguage.googleapis.com`, `query1.finance.yahoo.com`, `query2.finance.yahoo.com`

### Visa Agent
- Primary: cheerio (lightweight HTML parsing, ~150MB RAM)
- Fallback: Puppeteer + Chromium for JS-rendered sites (~1GB RAM)
- Egress: `generativelanguage.googleapis.com`, target visa appointment domain(s)

## Intent Router Logic

1. **Command Match** (fast path): Direct regex match on `/stock`, `/visa`, `/allow`, etc.
2. **LLM Fallback** (slow path): For free-text messages, use lightweight Gemini classification (~100 tokens)
3. **Unrouted Messages**: Logged at `WARN` level for manual review

## Data Persistence

- `data/dispatcher.sqlite` - Jobs, usage, allowed_users (survives restarts)
- `data/logs/` - Optional weekly archive of rotated logs
- `data/finance/` - Python execution workspace (charts, temp files)
- `data/visa/` - Scraper workspace (HTML cache, screenshots)

All `data/` contents are gitignored and mounted as Docker volumes.

## Hardware Requirements

- **Minimum**: 4GB RAM, dual-core CPU, 5GB storage
- **Recommended**: 8GB+ RAM for comfortable operation with Puppeteer fallback
