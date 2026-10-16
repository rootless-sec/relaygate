# RelayGate

> **High-Performance, Zero-Loss Webhook Ingestion Gateway & Dead-Letter Replay Hub**  
> Built by [rootless-sec](https://github.com/rootless-sec).

---

## ⚡ The Problem RelayGate Solves
When third-party providers (Midtrans, Xendit, Stripe, GitHub, Twilio) fire webhooks, downtime or deployment in your target services causes lost transactions, uncredited orders, and painful customer support issues.

**RelayGate** sits in front of your applications as a resilient ingestion gateway:
1. **< 5ms Ingestion ACK:** Accepts webhooks immediately and commits to a persistent SQLite Write-Ahead Log (WAL).
2. **Crash-Proof Queue:** Zero dropped events, even if your downstream service is down for hours.
3. **Automated Exponential Retries:** Smart backoff with jitter for transient errors.
4. **1-Click Manual Replay Dashboard:** Real-time dark-mode web console to inspect headers, diff payloads, and re-deliver dead-letter webhooks.
5. **Single Binary:** Everything (engine, SQLite storage, embedded React dashboard) ships in a single zero-dependency executable.

---

## 📁 Architecture & Specification
For the complete engineering contract, database schema, and module division, see [SPECIFICATION.md](./SPECIFICATION.md).

```
rootless-sec/relaygate/
├── cmd/
│   └── relaygate/       # Main single-binary executable
├── internal/
│   ├── model/           # Shared data contracts (event.go)
│   ├── storage/         # SQLite WAL persistence layer
│   ├── ingest/          # Fast HTTP ingestion handler
│   ├── verifier/        # HMAC verification (Midtrans, Stripe, generic)
│   ├── worker/          # Dispatcher pool & exponential backoff
│   └── api/             # REST & SSE control plane API
├── ui/                  # React + Vite + Tailwind dashboard (Linear zinc style)
├── Dockerfile           # Multi-stage zero-dependency build
└── docker-compose.yml
```

---

## 🚀 Quickstart

### Running with Docker
```bash
docker compose up -d
```
Dashboard will be available at `http://localhost:8080`.

### Building from Source (Go 1.22+)
```bash
# Build frontend
cd ui && npm install && npm run build && cd ..

# Build single binary
go build -o relaygate ./cmd/relaygate
./relaygate
```

---

## 🔒 Configuration & Security

RelayGate supports fine-grained security configuration via environment variables:

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `RELAYGATE_SESSION_ABSOLUTE_TIMEOUT` | `12h` | Maximum session lifetime regardless of activity. Expired sessions return 401 and are cleared. |
| `RELAYGATE_SESSION_IDLE_TIMEOUT` | `30m` | Inactivity timeout. Sessions idle longer than this window are invalidated. |
| `RELAYGATE_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Comma-separated list of trusted proxy CIDRs (defaults strictly to loopback). Invalid CIDRs cause relaygate to fail fast on startup. |
| `RELAYGATE_ALLOWED_ORIGINS` | _empty_ | Comma-separated list of additional allowed browser origins for CSRF validation (e.g., `https://dashboard.example.com`). |
| `RELAYGATE_WORKER_BASE_BACKOFF` | `10s` | Initial exponential backoff delay for retrying failed dispatches. Empty or invalid values fall back to `10s`. |
| `RELAYGATE_WORKER_POLL_INTERVAL` | `3s` | Polling interval for background retry workers. Empty or invalid values fall back to `3s`. |
| `RELAYGATE_WORKER_HTTP_TIMEOUT` | `15s` | Maximum HTTP request timeout when dispatching to downstream webhook targets. Empty or invalid values fall back to `15s`. |

### Cookie & Session Security Policy
RelayGate enforces a fixed `SameSite=Strict` policy for all session cookies without conditional header branching. Because RelayGate is an isolated same-origin Single Page Application, `SameSite=Strict` ensures session cookies are never transmitted during cross-site requests or third-party navigations, mitigating CSRF attacks fundamentally. Additionally, session cookies always include `HttpOnly` and `Path=/`, with the `Secure` attribute automatically applied when served over HTTPS or behind a trusted reverse proxy with `X-Forwarded-Proto: https`.

### Reverse Proxy Configuration (Nginx / Caddy)

When running RelayGate behind a reverse proxy (e.g., Nginx, Caddy, Cloudflare, Traefik), ensure your proxy forwards the real client IP and protocol headers:

#### Nginx Example
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
*Note:* Ensure `RELAYGATE_TRUSTED_PROXIES` includes the proxy's IP address (e.g., `127.0.0.1/32` or the internal Docker gateway `172.16.0.0/12`) so that `X-Forwarded-Proto: https` is recognized to automatically apply the `Secure` flag to session cookies.

---

## 🛡️ License
Apache-2.0 © [rootless-sec](https://github.com/rootless-sec)
