# RelayGate Architecture & Verification Engines

RelayGate is built to solve webhook fragility: when upstream payment gateways and SaaS platforms send webhooks while downstream applications are deploying, scaling, or temporarily down, events are lost once upstream retry budgets expire.

RelayGate acts as an unprivileged, self-contained buffer and control plane that validates incoming signatures, persists raw payloads to disk, and reliably delivers events to downstream targets.

---

## High-Level Architecture

```text
  Upstream Provider (Stripe, Midtrans, GitHub, Xendit, Shopify, Generic)
                         │
                         ▼  POST /ingest/{endpoint_id}
             ┌───────────────────────┐
             │ RelayGate Ingest API  │
             └───────────┬───────────┘
                         │
         1. Synchronous Disk Write
                         ▼
             ┌───────────────────────┐
             │ SQLite WAL Queue      │
             └───────────┬───────────┘
                         │
         2. Immediate HTTP 202 Accepted returned to Provider
                         │
                         ▼
             ┌───────────────────────┐
             │ Dispatcher Pool       │
             └───────────┬───────────┘
                         ├──► Cryptographic Signature Verification
                         ├──► Downstream HTTP Post (with exponential backoff)
                         └──► Real-Time SSE Stream (/api/v1/stream)
                                     │
                                     ▼
                          Embedded React Operator Console
```

---

## 1. Synchronous Ingestion Pipeline

When a webhook arrives at `/ingest/{endpoint_id}`:
1. RelayGate resolves the destination endpoint from in-memory cache or SQLite. If disabled or missing, it rejects the request immediately (`404 Not Found`).
2. The raw request body (up to 10 MB) and HTTP headers are captured as raw bytes without parsing or altering whitespace.
3. The event is written synchronously into SQLite with WAL (`Write-Ahead Logging`) mode enabled and `PRAGMA synchronous = NORMAL`.
4. Only after SQLite acknowledges the transaction on disk does RelayGate return `HTTP 202 Accepted` to the upstream provider with the generated event ID.

If the downstream application is dead, the process crashes, or the host restarts, all accepted events remain safely stored on disk and resume processing upon startup.

---

## 2. Cryptographic Verification Engines

RelayGate evaluates cryptographic authenticity using provider-specific verification modules in `internal/verifier/`:

| Provider | Signature Header | Verification Algorithm & Specification | Re-verifiable on Secret Update |
| :--- | :--- | :--- | :--- |
| `stripe` | `Stripe-Signature` | HMAC-SHA256 over `{timestamp}.{raw_body}` using shared webhook secret (`whsec_...`). Tolerates configurable clock skew (default 300 seconds). | Yes (unless timestamp is expired) |
| `midtrans` | `X-Midtrans-Signature` or JSON `signature_key` | SHA-512 hex digest of `order_id + status_code + gross_amount + server_key`. | Yes (unless JSON body is corrupt) |
| `github` | `X-Hub-Signature-256` | HMAC-SHA256 over raw payload bytes with `sha256=` prefix. | Yes |
| `xendit` | `X-Callback-Token` | Constant-time string equality comparison against configured callback token. | Yes |
| `shopify` | `X-Shopify-Hmac-Sha256` | HMAC-SHA256 over raw UTF-8 payload bytes using shared API secret, encoded as standard Base64 (with unpadded fallback tolerance). | Yes |
| `generic` | `X-RelayGate-Signature` / `X-Signature` | HMAC-SHA256 over raw request body (supports hex or `sha256=` format). | Yes |

All verification checks utilize constant-time comparison (`crypto/subtle.ConstantTimeCompare`) to defend against side-channel timing attacks.

---

## 3. Dead-Letter Queue (DLQ) & Diagnostic Engine

Events that cannot be delivered immediately transition through the worker lifecycle:
* `PENDING`: Enqueued in SQLite WAL, awaiting worker pickup.
* `RETRYING`: Delivery attempted but failed; scheduled with exponential backoff and randomized jitter (`attempt 1..N`).
* `DELIVERED`: Downstream returned `2xx`; event completed successfully.
* `FAILED`: Delivery attempts exhausted (`attempts >= max_attempts`) or signature rejected during verification.

### Replay Eligibility Rules

RelayGate enforces strict eligibility rules at the API level (`model.IsReplayEligible`) to protect downstream services and operators:

* **Eligible for Replay:**
  * Downstream network errors (connection timeout, DNS failure, connection refused).
  * Downstream HTTP server errors (`500`, `502`, `503`, `504 Gateway Timeout`).
  * Signature mismatches where the secret key on the endpoint was rotated or updated.
* **Ineligible for Replay:**
  * Missing signature headers (upstream provider never sent verification credentials).
  * Expired Stripe timestamps (`TIMESTAMP_EXPIRED`).
  * Permanently corrupted payload bodies that cannot parse.

When triggering a bulk replay, RelayGate automatically filters out ineligible items and returns a granular summary of processed vs skipped events.

### Duplicate Prevention (Keyed Mutex)

During replay execution, RelayGate uses an in-memory keyed mutex (`internal/worker/mutex.go`) combined with an atomic database status transition. If an operator triggers replay on an event that is currently being evaluated or delivered by a background worker, the API immediately returns `HTTP 409 Conflict`, preventing duplicate downstream webhook executions.

---

## 4. Security & Audit Architecture

* **Rootless Operation:** RelayGate runs as an unprivileged Linux user (non-root) on port `8080`.
* **Zero External Dependencies:** Built using standard library Go, embedded SQLite (`modernc.org/sqlite`), and embedded web assets (`embed.FS`).
* **Sensitive Header Masking:** All signature digests and auth tokens are masked as `••••••••` at the API boundary.
* **Fail-Closed Header Reveals:** Unmasking headers via `?reveal=1` requires an `ADMIN` session and records an immutable entry in `reveal_audit_logs`. If the audit log write fails, the entire request fails closed.
* **Strict CSRF Policy:** `SameSite=Strict` cookies combined with `Sec-Fetch-Site` and `Origin` validation defend all console operations.
