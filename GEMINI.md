# Agents of AI - Project Context

## Project Overview
**Agents of AI** is a self-hosted, multi-agent system designed to run on a local Linux machine. It leverages the "Micro-Agent Pod" architecture to provide specialized AI services via a unified Telegram interface. The system uses **Google Gemini** as its cognitive engine (Brain) while keeping execution local and secure.

## Architecture
The system consists of three isolated Docker containers managed by Docker Compose:

1.  **Dispatcher (Manager):**
    *   **Role:** The public face and gatekeeper. Connects to Telegram.
    *   **Responsibilities:** Authentication (User Whitelist), Routing (Intent Classification), Budgeting (Token Limits), and Scheduling (Cron Jobs).
    *   **Stack:** Node.js, Telegraf, SQLite.

2.  **Finance Agent (Worker):**
    *   **Role:** Quantitative analysis and financial plotting.
    *   **Stack:** Node.js (API), Python (Execution), `yfinance`, `matplotlib`.
    *   **Security:** Isolated workspace, no browser access.

3.  **Visa Agent (Worker):**
    *   **Role:** Monitoring visa appointment slots.
    *   **Stack:** Node.js (API), Puppeteer (Headless Browser).
    *   **Security:** Restricted network access, heavier resource usage.

**Communication:**
*   **External:** Users interact via Telegram.
*   **Internal:** Dispatcher communicates with Agents via a private Docker network (HTTP).

## Project Structure (Monorepo)
The project follows a standard npm workspaces monorepo structure:

```
AgentsofAI/
├── packages/
│   ├── shared/          # Common types, logger, auth middleware
│   ├── dispatcher/      # Telegram bot and orchestration logic
│   ├── finance-agent/   # Finance worker service
│   └── visa-agent/      # Visa worker service
├── data/                # Persistent storage (SQLite, Logs)
├── docker-compose.yml   # Orchestration config
├── Multi-Agent-Design.md # Detailed Design Specification
└── .env.example         # Environment configuration template
```

## Development Conventions

*   **Language:** TypeScript (Node.js) is the primary language for services. Python is used strictly for data analysis scripts in the Finance Agent.
*   **Security First:**
    *   All containers run as non-root users.
    *   Root filesystems are read-only.
    *   Strict network egress filtering (allowlists).
    *   Authentication is enforced at the Telegram level (ID Whitelist).
*   **Observability:**
    *   All logs must be structured JSON (using `pino`).
    *   Every request is traced with a `request_id`.
*   **State:** The Dispatcher is the *only* stateful component (using SQLite). Agents are stateless workers.

## Implementation Roadmap
(Refer to `Multi-Agent-Design.md` for detailed steps)

1.  **Phase 0: Scaffolding** (Monorepo setup, config)
2.  **Phase 1: Shared Package** (Logger, Auth, Types)
3.  **Phase 2: Dispatcher Core** (Telegram Bot, Router, DB)
4.  **Phase 3: Agents** (Finance & Visa logic)
5.  **Phase 4: Dockerization** (Container setup)
6.  **Phase 5: Security Hardening** (Egress rules, User permissions)
7.  **Phase 6: Observability** (Alerting, Status checks)

## Key Commands (Planned)

*   **Start System:** `docker compose up -d`
*   **View Logs:** `docker compose logs -f`
*   **Check Status:** `/status` (in Telegram)
*   **View Usage:** `/usage` (in Telegram)
