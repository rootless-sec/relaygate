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

## 🛡️ License
Apache-2.0 © [rootless-sec](https://github.com/rootless-sec)
