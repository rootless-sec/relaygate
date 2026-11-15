# Contributing to RelayGate

Thanks for helping improve RelayGate. This guide covers local setup, repository structure, required checks, and project conventions.

---

## Prerequisites

* **Go `1.26+`** (`go.mod` targets `go 1.26.0`; database access uses pure-Go `modernc.org/sqlite`, so `CGO_ENABLED=0` builds require no C compiler)
* **Node.js and npm** (for developing, testing, and bundling the Vite + React UI under `ui/`)

---

## Repository Layout

| Path | Responsibility |
| :--- | :--- |
| `cmd/relaygate/` | Main server binary (`relaygate`) and embedded `-agent` mode |
| `cmd/relaygate-agent/` | Standalone outbound WebSocket tunnel client (`relaygate-agent`) |
| `internal/ingest/` | Webhook intake handler, payload cap, rate limiting, and header sanitization |
| `internal/verifier/` | Constant-time webhook signature verifiers per provider |
| `internal/worker/` | Background delivery pool, retries, circuit breakers, and agent hub routing |
| `internal/agent/` | Pure-Go RFC 6455 WebSocket server hub, client reconnect loop, and wire framing |
| `internal/storage/` | SQLite WAL schema, queries, idempotency keys, and `VACUUM INTO` backups |
| `internal/api/` | Authenticated REST routes, SSE stream, RBAC middleware, and embedded UI serving |
| `internal/mailer/` | SMTP client for registration verification OTPs |
| `internal/notifier/` | Cooldown-guarded incident alerts (webhook, Telegram, Discord, Slack, SMTP) |
| `internal/model/` | Shared domain types, failure classification, and idempotency extraction |
| `ui/` | React 18, TypeScript, and Tailwind CSS v3 frontend embedded via `//go:embed ui/dist` |
| `test/` | End-to-end Go integration test suite |
| `docs/` | Detailed documentation (`agent.md`, `api.md`, `architecture.md`, `configuration.md`) |

---

## Local Development Workflow

1. Create a focused branch from `main` (for example `feat/provider-x`, `fix/dlq-filter`, or `docs/update-agent`).
2. Install UI dependencies once:

```bash
npm --prefix ui install
```

3. Run the frontend dev server if iterating on React components:

```bash
npm --prefix ui run dev
```

4. Run the Go server locally:

```bash
go run ./cmd/relaygate -addr 127.0.0.1:8080 -db ./data/relaygate.db -workers 10
```

5. If testing tunnel delivery against a local target, run the agent in another terminal:

```bash
go run ./cmd/relaygate-agent \
  -server http://127.0.0.1:8080 \
  -token agt_your_endpoint_token \
  -forward http://127.0.0.1:3000/webhooks
```

6. Because `relaygate` embeds `ui/dist` with `//go:embed`, rebuild `ui/dist` before compiling a single-binary build whenever files under `ui/` change:

```bash
npm --prefix ui run build
CGO_ENABLED=0 go build -o relaygate ./cmd/relaygate
CGO_ENABLED=0 go build -o relaygate-agent ./cmd/relaygate-agent
```

---

## Verification & Test Commands

Run both the UI suite and the Go test suite before opening a pull request:

```bash
npm --prefix ui test
npm --prefix ui run build
go test -count=1 ./...
```

Note on local development databases: `TestProdDatabaseState` in `test/` verifies that `./data/relaygate.db` starts clean without pre-existing test endpoints. If your local `./data/relaygate.db` contains development endpoints, run:

```bash
go test -count=1 ./internal/...
go test -count=1 ./test -skip TestProdDatabaseState
```

---

## Project Conventions

* **UI & Accessibility (`ui/src/`)**: Keep all colors within Tailwind neutral `zinc` and existing semantic accents (zero raw `#...` hex literals, verified by `ui/test/run-component-tests.js`). Every interactive control needs keyboard access, a visible focus ring, `Escape` dismissal on dialogs, and at least a `44px` touch target (`min-h-[44px]`) on mobile.
* **Security Boundaries**: Preserve constant-time comparisons (`crypto/subtle.ConstantTimeCompare`) in signature checks, strip client-supplied `X-User-*` headers at ingest, mask sensitive tokens/headers in API responses, and keep backup path confinement checks intact.
* **Documentation**: Keep `README.md` short and link out to dedicated guides (`CONTRIBUTING.md` or `docs/*.md`) rather than inlining long setup walkthroughs directly into `README.md`.
* **Formatting**: Avoid unicode em dashes and en dashes in source code, documentation, tests, and commit messages.

---

## Pull Requests

1. Keep each pull request scoped to one change with clear commit messages.
2. Include which tests you ran (`go test`, `npm --prefix ui test`, and any live browser or agent verification) in the PR description.
3. Wait for review feedback and keep commits tidy before merge.
