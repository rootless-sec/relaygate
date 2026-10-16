<p align="center">
  <img src="ui/public/logo.png" alt="RelayGate" width="84" height="84" />
</p>

<h1 align="center">RelayGate</h1>

<p align="center">
  Self-hosted webhook ingestion gateway, signature verifier, and dead-letter replay engine in a single Go binary.
</p>

---

When payment gateways or SaaS providers (Stripe, Midtrans, Xendit, GitHub) send webhooks while your downstream service is deploying, overloaded, or unreachable, events are dropped once the provider exhausts its retry window.

RelayGate sits in front of your application as a persistent ingestion queue and control plane. When a webhook arrives at `/ingest/{endpoint_id}`, RelayGate writes the raw payload and headers synchronously to a local SQLite Write-Ahead Log (WAL), returns `202 Accepted` to the provider, and hands the event off to a background worker pool.

If signature verification fails or a downstream target returns `4xx`/`5xx`/timeout responses after exponential backoff, the event moves to the Dead-Letter Queue (DLQ). Operators can inspect the failure diagnosis, rotate endpoint secrets, re-verify rejected payloads, and trigger single or bulk replays from the embedded web console.

## Architecture

```text
Provider (Stripe / Midtrans / Xendit / GitHub / Generic)
   │
   ▼  POST /ingest/{endpoint_id}
RelayGate Ingest Handler
   │
   ├──► SQLite WAL (synchronous disk write before HTTP 202 ACK)
   │
   ▼
Worker Pool & Verifier
   ├──► Signature / Token Verification (HMAC-SHA256, SHA-512, Constant-Time Token)
   ├──► Downstream HTTP Dispatcher (exponential backoff + jitter, per-event mutex)
   └──► SSE Hub (/api/events/stream) ──► Embedded React Console (ui/dist via embed.FS)
```

### Repository Layout

```text
relaygate/
├── cmd/
│   └── relaygate/       # Main entrypoint and graceful shutdown bootstrap
├── internal/
│   ├── api/             # REST handlers, session auth, CSRF middleware, SSE hub
│   ├── ingest/          # High-speed webhook ingestion handler
│   ├── mailer/          # SMTP mailer for 6-digit registration OTPs
│   ├── model/           # Domain models, failure codes, and eligibility rules
│   ├── storage/         # SQLite WAL persistence, migrations, and audit logs
│   ├── verifier/        # Provider signature and callback token verifiers
│   └── worker/          # Concurrent dispatcher pool and backoff scheduler
├── test/                # End-to-end integration tests
└── ui/                  # React + TypeScript + Tailwind CSS console (embedded via embed.FS)
```

## Provider Verification

RelayGate determines verification semantics per endpoint (`hmac`, `hash`, or `static_token`) and records structured failure codes when validation fails:

| Provider | Header | Algorithm & Input | Re-verifiable on Secret Update |
| :--- | :--- | :--- | :--- |
| `stripe` | `Stripe-Signature` | HMAC-SHA256 over `{timestamp}.{raw_body}` (`v1=` scheme, 5-minute replay tolerance) | Yes (except expired/invalid timestamps) |
| `midtrans` | `X-Midtrans-Signature` or body `signature_key` | SHA-512 hex digest of `order_id + status_code + gross_amount + secret_key` | Yes (except malformed JSON payloads) |
| `xendit` | `X-Callback-Token` | Constant-time equality comparison against endpoint secret key | Yes |
| `github` | `X-Hub-Signature-256` | HMAC-SHA256 over raw request body (`sha256=` prefix) | Yes |
| `generic` | `X-RelayGate-Signature` | HMAC-SHA256 over raw request body (hex or `sha256=` prefix) | Yes |

## Dead-Letter Queue and Replay Semantics

Events in `FAILED` state are categorized by server-assigned `failure_code` values (`SIGNATURE_MISMATCH`, `SIGNATURE_HEADER_MISSING`, `TIMESTAMP_EXPIRED`, `TIMESTAMP_INVALID`, `PAYLOAD_CORRUPT`, `DELIVERY_4XX`, `DELIVERY_5XX`, `DELIVERY_TIMEOUT`).

1. Server-side eligibility (`model.IsReplayEligible`) governs both single-event replay and bulk replay. Events missing required headers, carrying expired Stripe timestamps, or containing corrupt JSON bodies cannot be replayed and are automatically excluded from bulk operations with an explicit breakdown.
2. Replaying an eligible event resets `attempts` to `0`, transitions status to `PENDING`, preserves the last `http_status_code` for operator context, and guards against concurrent duplicate dispatches via a per-event keyed mutex and atomic database transition (`409 Conflict` on duplicate in-flight requests).
3. Sensitive headers matching authentication keywords (`token`, `secret`, `signature`, `auth`, `key`, `password`, `cookie`) are masked as `••••••••` in API responses and replaced with `<TOKEN>` in generated `cURL` commands. Revealing raw header values requires an `ADMIN` session and writes an immutable entry to `reveal_audit_logs` before returning data (fail-closed).

## Building and Running

### Prerequisites

* Go 1.22 or newer (pure Go SQLite driver via `modernc.org/sqlite`, no CGO required)
* Node.js 20+ (only required when rebuilding frontend assets in `ui/dist`)

### Build from Source

```bash
# 1. Build frontend assets (optional if ui/dist is already up to date)
cd ui
npm install
npm run build
cd ..

# 2. Compile standalone binary
go build -o relaygate ./cmd/relaygate

# 3. Start server (listens on :8080 by default, stores SQLite DB in ./data/relaygate.db)
./relaygate
```

Open `http://127.0.0.1:8080` in your browser to access the dashboard.

### Running Tests

```bash
# Run all Go unit, security, worker, and E2E integration tests with race detector
go test -race -count=1 ./...

# Run frontend component and cross-state invariant tests
npm --prefix ui test
```

## API Reference

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/ingest/{endpoint_id}` | Public (Provider Signature) | Ingest webhook payload into SQLite WAL and enqueue dispatch |
| `POST` | `/api/auth/register` | Public | Register a new account and issue a 6-digit email verification code |
| `POST` | `/api/auth/verify` | Public | Verify 6-digit OTP code and activate user account |
| `POST` | `/api/auth/login` | Public | Authenticate user and set `HttpOnly; SameSite=Strict` session cookie |
| `POST` | `/api/auth/logout` | Session | Revoke active server-side session and clear cookie |
| `GET` | `/api/stats` | Session / Bearer | Aggregate KPI counts (`total`, `delivered`, `pending`, `retrying`, `failed`) |
| `GET` | `/api/events` | Session / Bearer | List events with filtering (`status`, `provider`, `failure_code`, `search`) |
| `GET` | `/api/events/{id}` | Session / Bearer | Fetch single event details with masked sensitive headers |
| `POST` | `/api/events/{id}/reveal-headers` | Session (`ADMIN`) | Audit and return unmasked request headers for a specific event |
| `POST` | `/api/events/{id}/replay` | Session / Bearer | Reset attempts and enqueue immediate re-verification and delivery |
| `POST` | `/api/events/replay-bulk` | Session / Bearer | Preview or execute bulk replay for all eligible `FAILED` events |
| `GET` | `/api/events/stream` | Session / Bearer | Server-Sent Events (SSE) real-time status stream |
| `GET` | `/api/endpoints` | Session / Bearer | List configured webhook endpoints |
| `POST` | `/api/endpoints` | Session (`ADMIN`) | Create a new webhook endpoint |
| `PUT` | `/api/endpoints/{id}` | Session (`ADMIN`) | Update endpoint target URL, provider, secret key, or active status |
| `DELETE` | `/api/endpoints/{id}` | Session (`ADMIN`) | Delete a webhook endpoint |

## Configuration and Security

RelayGate is configured via environment variables:

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAYGATE_SESSION_ABSOLUTE_TIMEOUT` | `12h` | Maximum session lifetime regardless of activity. Expired sessions return `401` and are deleted. |
| `RELAYGATE_SESSION_IDLE_TIMEOUT` | `30m` | Inactivity timeout window before a session is invalidated. |
| `RELAYGATE_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Comma-separated list of trusted proxy CIDRs. Invalid CIDRs abort startup immediately. |
| `RELAYGATE_ALLOWED_ORIGINS` | _empty_ | Comma-separated list of additional allowed browser origins for CSRF validation. |
| `RELAYGATE_WORKER_BASE_BACKOFF` | `10s` | Initial exponential backoff delay for retrying failed dispatches. |
| `RELAYGATE_WORKER_POLL_INTERVAL` | `3s` | Polling interval for background retry workers. |
| `RELAYGATE_WORKER_HTTP_TIMEOUT` | `15s` | HTTP client timeout when dispatching to downstream target URLs. |

### Cookie and CSRF Policy

Session tokens are hashed with SHA-256 before database storage. Session cookies enforce `HttpOnly`, `Path=/`, and a fixed `SameSite=Strict` policy without conditional header branching. The `Secure` attribute is enabled automatically on direct TLS connections or when `X-Forwarded-Proto: https` arrives from a peer matching `RELAYGATE_TRUSTED_PROXIES`.

All state-mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) authenticated via session cookie are validated against `Sec-Fetch-Site` and `Origin`/`Referer` host matching. Requests authenticated exclusively via `Authorization: Bearer <token>` without a session cookie bypass browser CSRF checks.

### Reverse Proxy Example (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name relaygate.example.com;

    ssl_certificate     /etc/ssl/certs/relaygate.crt;
    ssl_certificate_key /etc/ssl/private/relaygate.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Ensure `RELAYGATE_TRUSTED_PROXIES` includes the reverse proxy IP or CIDR (for example `127.0.0.1/32` or your internal container network) so `X-Forwarded-Proto` and `X-Forwarded-For` are trusted.

## License

Apache-2.0. Built by [Rootless Security](https://github.com/rootless-sec).
