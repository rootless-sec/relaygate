# RelayGate Configuration & Deployment

RelayGate compiles into a single, static binary with embedded web assets and an embedded pure-Go SQLite driver. It requires no external database, no Redis, and no CGO dependencies.

---

## CLI Flags

RelayGate accepts command-line flags on startup:

```bash
./relaygate -addr :8080 -db ./data/relaygate.db -workers 10
```

| Flag | Default | Environment Override | Description |
| :--- | :--- | :--- | :--- |
| `-addr` | `:8080` | `RELAYGATE_ADDR` / `PORT` | Listening host and TCP port |
| `-db` | `./data/relaygate.db` | `RELAYGATE_DB_PATH` | Path to the SQLite database file |
| `-workers` | `10` | `RELAYGATE_WORKERS` | Number of concurrent background delivery worker goroutines |

---

## Environment Variables

All settings can be configured via environment variables or a local `.env` file:

### Server & Dispatcher

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAYGATE_ADDR` / `PORT` | `:8080` | TCP listen address (e.g. `127.0.0.1:8080` or `:8080`) |
| `RELAYGATE_DB_PATH` | `./data/relaygate.db` | File path for SQLite storage (WAL mode enabled automatically) |
| `RELAYGATE_WORKERS` | `10` | Number of worker goroutines processing inbound events |
| `RELAYGATE_WORKER_BASE_BACKOFF` | `10s` | Initial exponential backoff delay for failed dispatches |
| `RELAYGATE_WORKER_POLL_INTERVAL` | `3s` | Sleep duration between polling cycles when queue is idle |
| `RELAYGATE_WORKER_HTTP_TIMEOUT` | `15s` | Timeout for HTTP POST delivery attempts to downstream services |

### Security, Sessions & CSRF

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAYGATE_SESSION_ABSOLUTE_TIMEOUT` | `12h` | Maximum session lifetime regardless of user activity |
| `RELAYGATE_SESSION_IDLE_TIMEOUT` | `30m` | Inactivity window before an idle session expires |
| `RELAYGATE_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Comma-separated CIDR list of trusted reverse proxies. Startup aborts if any CIDR is invalid. |
| `RELAYGATE_ALLOWED_ORIGINS` | _empty_ | Comma-separated list of allowed browser origins for cross-origin console deployments |

### Email SMTP Service (OTP Verification)

When registering new operator accounts, RelayGate delivers a 6-digit verification code. If `SMTP_HOST` is empty, RelayGate operates in local development mode (logging the OTP to console and displaying a dev preview helper in the UI).

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SMTP_HOST` | _empty_ | SMTP server host (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | `587` | SMTP submission port (`587` for STARTTLS, `465` for SSL) |
| `SMTP_USER` | _empty_ | SMTP authentication username / email |
| `SMTP_PASS` | _empty_ | SMTP authentication password or app-specific password |
| `SMTP_FROM` | `RelayGate <noreply@relaygate.local>` | From email address header |

---

## Reverse Proxy Examples

### Nginx

Place RelayGate behind Nginx to terminate TLS:

```nginx
server {
    listen 443 ssl http2;
    server_name relaygate.internal.net;

    ssl_certificate     /etc/ssl/certs/relaygate.crt;
    ssl_certificate_key /etc/ssl/private/relaygate.key;

    # Limit maximum webhook payload size (default 10MB)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # SSE stream support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

*Ensure `RELAYGATE_TRUSTED_PROXIES` includes `127.0.0.1/32` (or your internal subnet) so `X-Forwarded-For` and `X-Forwarded-Proto` are trusted.*

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

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
