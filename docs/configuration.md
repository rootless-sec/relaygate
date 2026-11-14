# RelayGate Configuration & Deployment

RelayGate compiles into a single static binary containing the Go engine, an embedded pure-Go SQLite driver (`modernc.org/sqlite`), and the Vite/React bundle (`ui/dist` via `go:embed`). No external database, message broker, or CGO runtime is required.

---

## CLI Flags

```bash
./relaygate -addr 127.0.0.1:8080 -db ./data/relaygate.db -workers 10
```

| Flag | Default | Environment Override | Description |
| :--- | :--- | :--- | :--- |
| `-addr` | `:8080` | `RELAYGATE_ADDR` / `PORT` | TCP listen host and port |
| `-db` | `./data/relaygate.db` | `RELAYGATE_DB_PATH` | Path to the SQLite database file |
| `-workers` | `10` | `RELAYGATE_WORKERS` | Number of concurrent HTTP dispatch worker goroutines |
| `-agent` | `false` | - | Run in embedded `relaygate-agent` tunnel mode instead of starting the HTTP server (uses `-server`, `-token`, `-forward`, `-timeout`) |

### `relaygate-agent` CLI Flags (Local Outbound Forwarder)

```bash
./relaygate-agent -server http://127.0.0.1:8080 -token agt_your_endpoint_token -forward http://127.0.0.1:3000/webhooks
```

| Flag | Default | Description |
| :--- | :--- | :--- |
| `-server` | `http://127.0.0.1:8080` | RelayGate server base URL (`http://`, `https://`, `ws://`, or `wss://`) |
| `-token` | (required) | Endpoint agent token (`agt_...`) shown in the Endpoints view |
| `-forward` | `""` (endpoint `target_url`) | Optional local private HTTP service URL override for forwarded webhook POST requests |
| `-timeout` | `15s` | Local HTTP forward timeout |

`cmd/relaygate/main.go` automatically loads key-value pairs from a local `.env` file on startup when the corresponding environment variable is unset.

---

## Environment Variables

### Server, Worker Pool & Retention

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAYGATE_ADDR` / `PORT` | `:8080` | HTTP server listen address (`PORT` applies if `RELAYGATE_ADDR` is unset) |
| `RELAYGATE_DB_PATH` | `./data/relaygate.db` | SQLite WAL file path |
| `RELAYGATE_WORKERS` | `10` | Worker goroutine pool concurrency |
| `RELAYGATE_WORKER_BASE_BACKOFF` | `10s` | Initial exponential backoff duration (`base * 2^attempt` with +/- 20% jitter, capped at `1h`) |
| `RELAYGATE_WORKER_POLL_INTERVAL` | `3s` | Database polling interval for pending retries and crash-recovery pickups |
| `RELAYGATE_WORKER_HTTP_TIMEOUT` | `15s` | Per-attempt downstream HTTP POST timeout |
| `RELAYGATE_RETENTION_DAYS` | `30` | Age threshold in days for pruning `DELIVERED` events every hour (`FAILED`, `PENDING`, and `RETRYING` rows are never pruned). Set `0` to disable background pruning. |

### Security, Sessions & CSRF

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAYGATE_SESSION_ABSOLUTE_TIMEOUT` | `12h` | Maximum lifetime of an operator session before mandatory re-login |
| `RELAYGATE_SESSION_IDLE_TIMEOUT` | `30m` | Inactivity timeout for active sessions |
| `RELAYGATE_TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs or CIDRs trusted for `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Invalid CIDR syntax aborts startup. Alias: `TRUSTED_PROXIES`. |
| `RELAYGATE_ALLOWED_ORIGINS` | _empty_ | Comma-separated additional browser origins allowed for CSRF checks on cookie-authenticated mutations |
| `RELAYGATE_ENV` | _empty_ | Set to `production` (or `prod`) to disable console dev OTP fallbacks when SMTP is absent |

### Email SMTP Services (Auth OTP vs Incident Alerts)

RelayGate uses two distinct sets of SMTP environment variables in the current codebase:

| Subsystem | Variables | Default Port / From | Purpose |
| :--- | :--- | :--- | :--- |
| Account OTP Mailer (`internal/mailer`) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `587`, `RelayGate <noreply@relaygate.local>` | Sends 6-digit email verification codes on `POST /api/v1/auth/register`. Logs OTP preview in non-production dev mode when `SMTP_HOST` is unset. |
| Endpoint Incident Notifier (`internal/notifier`) | `RELAYGATE_SMTP_HOST`, `RELAYGATE_SMTP_PORT`, `RELAYGATE_SMTP_USER`, `RELAYGATE_SMTP_PASS`, `RELAYGATE_SMTP_FROM` | `587`, `alerts@relaygate.local` | Sends plain-text incident emails to an endpoint's `notification_email` when events enter DLQ or a circuit breaker trips. Falls back to `[NOTIFIER DEV EMAIL]` console log if unset. |

---

## Per-Endpoint Incident Channels & Hot Backup Paths

1. Webhook incident sinks configured on an endpoint (`notification_url`, `telegram_webhook` + `telegram_chat_id`, `discord_webhook`, `slack_webhook`) receive JSON `POST` payloads (`endpoint_id`, `endpoint_name`, `event_id`, `reason`, `timestamp`, `text`, `content`, and optional `chat_id`) with a 3-second HTTP timeout.
2. `notifier.Manager` enforces a thread-safe 5-minute cooldown window per `endpoint_id` (`DefaultCooldownWindow`) so sustained downstream outages do not flood Slack, Discord, Telegram, or SMTP mailboxes.
3. Database backups via `POST /api/v1/system/backup` write snapshots under `data/backups/` relative to the working directory by default. Custom `destination_path` inputs are confined strictly inside the working directory or OS temporary directory (`os.TempDir()`), blocking `..` segments, null bytes, drive/filesystem roots, and OS system directories.

---

## Reverse Proxy Examples

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name relaygate.internal.net;

    ssl_certificate     /etc/ssl/certs/relaygate.crt;
    ssl_certificate_key /etc/ssl/private/relaygate.key;

    # Match RelayGate MaxPayloadBytes (10 MB)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # Disable buffering for GET /api/v1/stream (SSE)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    location /api/v1/agent/connect {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }
}
```

Ensure `RELAYGATE_TRUSTED_PROXIES` includes the Nginx peer IP (e.g. `127.0.0.1/32`) so RelayGate honors `X-Forwarded-For` and `X-Forwarded-Proto`.

### Caddy

```caddy
relaygate.internal.net {
    reverse_proxy 127.0.0.1:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
```

---

## Systemd Service

Create `/etc/systemd/system/relaygate.service`:

```ini
[Unit]
Description=RelayGate Webhook Ingestion Engine
After=network.target

[Service]
Type=simple
User=relaygate
Group=relaygate
WorkingDirectory=/opt/relaygate
ExecStart=/opt/relaygate/relaygate -addr 127.0.0.1:8080 -db /opt/relaygate/data/relaygate.db -workers 16
Restart=always
RestartSec=5s

NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
