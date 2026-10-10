# PROJECT SPECIFICATION & AGENT EXECUTION BLUEPRINT
# Project: RelayGate (`rootless-sec/relaygate`)
# Revision: 1.0.0-PROD
# Target Environment: Go 1.22+ | SQLite (WAL Mode) | React/Vite/Tailwind | Docker

---

## 1. Executive Summary & Problem Statement

### 1.1 The Industry Problem
Payment gateways, logistics platforms, and SaaS webhooks (**Midtrans, Xendit, Stripe, Flip, Twilio, GitHub**) operate on asynchronous fire-and-forget HTTP requests. 
When a downstream service experiences downtime, deployments, high load, or network partition:
1. Webhooks fail silently or get dropped after limited provider retries.
2. Orders remain uncredited, licenses are unissued, and customers panic.
3. Developers lack a centralized, self-hosted replay buffer to inspect and re-deliver payloads.

Existing solutions (e.g., Hookdeck, Svix) are expensive cloud SaaS ($100s–$1000s/month) or require complex AWS SQS/Lambda infrastructure.

### 1.2 The RelayGate Solution
**RelayGate** is an ultra-fast, zero-loss, self-hosted webhook ingestion gateway and dead-letter replay engine packaged as a **single standalone binary** with an embedded high-performance dark-mode UI.

```
[ Providers (Stripe/Midtrans) ] 
               │
               ▼  (HTTP POST < 5ms ingestion)
       [ RelayGate Engine ] ──(Sync Write WAL)──► [ SQLite Disk Queue ]
               │
               ├─► [ Verifier (HMAC validation) ]
               ├─► [ Dispatcher Pool ] ──(HTTP POST + Backoff)──► [ Target App API ]
               │
               ▼  (Internal SSE & REST API)
       [ Embedded Web Dashboard ] ◄── (1-Click Replay & Inspect)
```

---

## 2. Tech Stack & Non-Negotiable Constraints

1. **Language & Backend:** Go 1.22+ (Pure Go / minimal CGO dependencies using `modernc.org/sqlite` or battle-tested SQLite drivers).
2. **Storage Layer:** SQLite with Write-Ahead Logging (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`). Zero external database servers required.
3. **Frontend Dashboard:** React 18+ / Vite + Tailwind CSS + Lucide Icons. Bundled directly into the Go binary using Go 1.16+ `embed.FS`.
4. **Distribution:** Single portable binary + multi-stage minimal Docker container (`alpine` or `scratch`).
5. **Engineering Standard:**
   - **Zero Fake Implementations / Zero Mocks:** All storage, network proxies, retries, and HMAC verification must be 100% real and functional.
   - **Defensive Ingestion:** Ingestion must acknowledge HTTP 200/202 to the provider within `< 5ms` immediately after disk persistence. Verification and dispatch occur asynchronously to prevent provider timeouts.

---

## 3. The Shared Contract: Models & API Specifications

> **RULE:** Both Dev A and Dev B MUST strictly adhere to this schema. Do NOT alter field names or types without mutual agreement.

### 3.1 Database Schema (`internal/storage/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    target_url TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'generic', -- generic, midtrans, stripe, xendit, github
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,                       -- UUID v4 or ULID
    endpoint_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    headers TEXT NOT NULL,                     -- JSON serialized key-value map
    payload BLOB NOT NULL,                     -- Raw byte payload
    signature TEXT,                            -- Signature header if present
    is_verified INTEGER NOT NULL DEFAULT 0,    -- 0: unverified, 1: valid, -1: invalid
    status TEXT NOT NULL,                      -- 'PENDING', 'DELIVERED', 'FAILED', 'RETRYING'
    http_status_code INTEGER DEFAULT 0,        -- Last response from target
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    next_retry_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_events_next_retry ON webhook_events(next_retry_at) WHERE status = 'RETRYING';
CREATE INDEX IF NOT EXISTS idx_events_created ON webhook_events(created_at DESC);
```

### 3.2 Go Data Structs (`internal/model/event.go`)

```go
package model

import "time"

type ProviderType string

const (
	ProviderGeneric  ProviderType = "generic"
	ProviderMidtrans ProviderType = "midtrans"
	ProviderStripe   ProviderType = "stripe"
	ProviderXendit   ProviderType = "xendit"
	ProviderGithub   ProviderType = "github"
)

type EventStatus string

const (
	StatusPending   EventStatus = "PENDING"
	StatusDelivered EventStatus = "DELIVERED"
	StatusFailed    EventStatus = "FAILED"
	StatusRetrying  EventStatus = "RETRYING"
)

type WebhookEvent struct {
	ID             string            `json:"id"`
	EndpointID     string            `json:"endpoint_id"`
	Provider       ProviderType      `json:"provider"`
	SourceIP       string            `json:"source_ip"`
	Headers        map[string]string `json:"headers"`
	Payload        []byte            `json:"payload"`
	Signature      string            `json:"signature,omitempty"`
	IsVerified     int               `json:"is_verified"` // 1: valid, 0: skipped/unknown, -1: invalid
	Status         EventStatus       `json:"status"`
	HTTPStatusCode int               `json:"http_status_code"`
	Attempts       int               `json:"attempts"`
	MaxAttempts    int               `json:"max_attempts"`
	LastError      string            `json:"last_error,omitempty"`
	NextRetryAt    *time.Time        `json:"next_retry_at,omitempty"`
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`
}

type Endpoint struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	SecretKey string       `json:"secret_key"`
	TargetURL string       `json:"target_url"`
	Provider  ProviderType `json:"provider"`
	IsActive  bool         `json:"is_active"`
	CreatedAt time.Time    `json:"created_at"`
}
```

### 3.3 Control Plane REST & SSE API (`internal/api`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/ingest/:endpoint_id` | Public ingestion receiver for external providers |
| `GET` | `/api/v1/events` | List events with pagination (`?page=1&limit=50&status=FAILED`) |
| `GET` | `/api/v1/events/:id` | Get single event details (headers, raw payload, error) |
| `POST` | `/api/v1/events/:id/replay` | Manually trigger immediate replay for a single event |
| `POST` | `/api/v1/events/bulk-replay`| Bulk replay all events matching criteria (e.g. `{"status": "FAILED"}`) |
| `GET` | `/api/v1/endpoints` | List all configured webhook endpoints |
| `POST` | `/api/v1/endpoints` | Register a new target webhook endpoint |
| `GET` | `/api/v1/stream` | Server-Sent Events (SSE) stream for live real-time dashboard events |
| `GET` | `/api/v1/stats` | Dashboard statistics (total, delivered, retrying, dead-letter count) |

---

## 4. Workload Division & Responsibilities

### 4.1 Dev A: Core Engine, Storage & Dispatcher

**Primary Objective:** Deliver a high-throughput, crash-resilient ingestion server and retry worker.

#### Assigned Repository Directories:
* `cmd/relaygate/main.go` (Server bootstrapping, graceful shutdown)
* `internal/storage/` (SQLite WAL repository, migrations, queries)
* `internal/ingest/` (Fast HTTP ingestion handler)
* `internal/verifier/` (HMAC cryptographic verification for Midtrans, Stripe, etc.)
* `internal/worker/` (Retry dispatcher, exponential backoff, worker pool)

#### Dev A Implementation Checklist:
1. **Fast Ingest Handler (`internal/ingest`):**
   - Read request headers, source IP, and raw body (limit max body to 10MB).
   - Write synchronously to SQLite queue in WAL mode.
   - Return `HTTP 200 OK` (with JSON `{"status": "queued", "id": "<id>"}`) in `< 5ms`.
   - Asynchronously push task ID to internal dispatcher channel.
2. **Persistence Layer (`internal/storage`):**
   - Initialize SQLite DB file `relaygate.db`.
   - Execute table creation & index migrations safely.
   - Implement repository methods: `SaveEvent`, `GetEventByID`, `ListEvents`, `UpdateEventStatus`, `GetPendingRetries`.
3. **HMAC Signature Verifiers (`internal/verifier`):**
   - **Generic:** Optional SHA256 HMAC verification against `endpoint.secret_key`.
   - **Midtrans:** SHA512 hash verification (`order_id + status_code + gross_amount + ServerKey`).
   - **Stripe:** `v1` timestamp & signature validation (`t=...,v1=...`).
4. **Dispatcher & Retry Pool (`internal/worker`):**
   - Worker pool with configurable concurrency (e.g., 10 concurrent HTTP dispatchers).
   - Forward headers (excluding host/hop-by-hop headers) + original payload to `endpoint.target_url`.
   - Record response status code and execution duration.
   - If response is `2xx`: mark status as `DELIVERED`.
   - If response is `4xx`, `5xx`, or timeout:
     - Increment `attempts`.
     - Calculate next retry time with exponential backoff + jitter:
       $$t_{\text{retry}} = \text{base} \times 2^{\text{attempt}} \pm \text{jitter}$$
       (e.g., 10s, 30s, 2m, 10m, 1h).
     - If `attempts >= max_attempts`, mark status as `FAILED` (Dead Letter Queue).
5. **Graceful Shutdown:**
   - Listen to `SIGINT` / `SIGTERM`. Finish in-flight dispatches cleanly before closing SQLite connection.

---

### 4.2 Dev B: Control Plane API, Real-Time SSE & Web Dashboard

**Primary Objective:** Build a clean, dark-mode real-time monitoring dashboard and embed it into the Go binary.

#### Assigned Repository Directories:
* `internal/api/` (REST handlers, SSE event broadcaster)
* `ui/` (React + Vite + Tailwind project)
* `internal/assets/` (Go `embed.FS` integration)
* `Dockerfile` & `docker-compose.yml`

#### Dev B Implementation Checklist:
1. **Control Plane Handlers (`internal/api`):**
   - Implement `GET /api/v1/events` with query filters (`status`, `endpoint_id`, search keyword).
   - Implement `POST /api/v1/events/:id/replay`: immediately push event to Dev A's dispatcher queue and reset status to `PENDING`.
   - Implement SSE Broadcaster (`/api/v1/stream`): broadcast every new event ingestion and delivery status update to all connected browser tabs.
2. **Dashboard UI (`ui/`):**
   - **Design Aesthetic:** Minimalist dark mode (Tailwind `zinc-900` / `zinc-950` backgrounds, `slate-400` text, subtle borders `zinc-800`). No neon colors.
   - **Live Ingestion Feed:** Real-time table streaming events as they arrive via SSE.
   - **Status Badges:**
     - `DELIVERED`: Emerald badge (`bg-emerald-950 text-emerald-400 border-emerald-800`)
     - `RETRYING`: Amber badge (`bg-amber-950 text-amber-400 border-amber-800`)
     - `FAILED`: Rose badge (`bg-rose-950 text-rose-400 border-rose-800`)
   - **Inspector Modal / Drawer:**
     - Display request headers (copyable).
     - Pretty-printed JSON payload viewer with syntax highlighting and 1-click copy.
     - Response log from downstream target (HTTP status code, body, latency).
   - **1-Click Replay Button:** Instantly re-send failed webhook payloads.
3. **Single Binary Embed (`internal/assets` / `cmd/relaygate`):**
   - Configure Vite to build to `ui/dist`.
   - Embed `ui/dist` using `//go:embed all:ui/dist` in Go so running `relaygate` serves both the API and the web frontend from a single file.
4. **Containerization & DX:**
   - Write multi-stage `Dockerfile`:
     - Stage 1: Build React frontend with Node.
     - Stage 2: Build Go binary with embedded assets.
     - Stage 3: Minimal Alpine/Scratch image (<25MB total footprint).
   - Write `docker-compose.yml` mounting local volume for `./data/relaygate.db`.

---

## 5. Step-by-Step Execution Plan (Day 1)

### Phase 0: Setup & Contract Freezing (30 Minutes - Done Together)
1. Initialize Git repository at `github.com/rootless-sec/relaygate`.
2. Commit `SPECIFICATION.md` to root.
3. Create `internal/model/event.go` with shared structs.
4. Commit to `main` branch. This is the immutable contract.

### Phase 1: Parallel Development (Simultaneous - Zero Conflicts)
* **Dev A Branch:** `feat/core-engine-and-storage`
  - Write SQLite migrations and repository in `internal/storage/`.
  - Write ingestion handler and worker dispatcher in `internal/ingest/` & `internal/worker/`.
* **Dev B Branch:** `feat/dashboard-and-control-api`
  - Build Vite + React UI in `ui/`.
  - Build REST API endpoints and SSE stream in `internal/api/` using mock storage initially or directly binding to `internal/model`.

### Phase 2: Integration & Wiring (1 Hour)
* Merge Dev A and Dev B branches into `develop` or `main`.
* Connect Dev B's REST handlers to Dev A's storage repository methods.
* Wire Dev A's ingestion events into Dev B's SSE broadcaster.
* Run end-to-end webhook replay test.

### Phase 3: Packaging & Release
* Verify `embed.FS` serves `http://localhost:8080`.
* Build Docker image and test with local Midtrans/Stripe mock webhook.
* Tag `v0.1.0`.

---

## 6. Antigravity Agent Kickoff Prompts

When you and your teammate hand this task to Antigravity, use the exact instructions below.

### 📋 Prompt for Dev A (Core Engine):
```markdown
You are Dev A on the project "rootless-sec/relaygate".
Read the project blueprint in SPECIFICATION.md.
Your responsibility is strictly:
1. internal/storage: Implement the SQLite WAL repository, schema migrations, and event persistence methods.
2. internal/verifier: Implement HMAC verifiers (Generic HMAC-SHA256, Midtrans SHA512, Stripe).
3. internal/worker: Implement the worker pool, HTTP dispatcher, and exponential backoff retry mechanism.
4. internal/ingest: Implement the high-speed <5ms HTTP ingest endpoint.
5. cmd/relaygate: Bootstrap the core engine with graceful shutdown.

Rules:
- Strictly follow the schema and models in internal/model/event.go.
- Do NOT build mock or fake delays; write production-ready Go code.
- Do NOT modify files inside internal/api/ or ui/ (those belong to Dev B).
Begin by implementing internal/storage and internal/model.
```

### 📋 Prompt for Dev B (UI & Control Plane):
```markdown
You are Dev B on the project "rootless-sec/relaygate".
Read the project blueprint in SPECIFICATION.md.
Your responsibility is strictly:
1. internal/api: Implement the REST API handlers (List, Detail, Replay, Bulk Replay, Stats) and SSE stream broadcaster (/api/v1/stream).
2. ui/: Build the modern, minimalist dark-mode dashboard (Vite + React + Tailwind + Lucide Icons) styled in Linear/Vercel zinc aesthetic.
3. Assets Embedding: Embed ui/dist into the Go binary using embed.FS.
4. Dockerfile & docker-compose.yml: Deliver a multi-stage build resulting in a single container running at port 8080.

Rules:
- Strictly follow the schema and models in internal/model/event.go.
- Do NOT modify files inside internal/storage/ or internal/worker/ (those belong to Dev A).
Begin by setting up internal/api routes and bootstrapping the ui/ dashboard.
```
