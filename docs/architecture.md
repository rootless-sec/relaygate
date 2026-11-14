# RelayGate Architecture & Internals

RelayGate buffers inbound webhooks onto local SQLite WAL storage, isolates slow or failing downstream targets with per-destination circuit breakers and `Retry-After` deferrals, normalizes multi-target payloads on demand, and logs every dispatch attempt for dead-letter triage.

---

## High-Level Data Flow

```text
  Upstream Providers (Stripe, Midtrans, GitHub, Xendit, Shopify, DOKU, Flip, Generic)
                         │
                         ▼  POST /ingest/{endpoint_id}
             ┌───────────────────────────────────────┐
             │ internal/ingest/handler.go            │
             │  - 10 MB body cap & IP/endpoint limit │
             │  - Strip spoofed X-User-* headers     │
             │  - Capture X-RelayGate-Request-Target │
             │  - Extract upstream idempotency key   │
             └───────────────────┬───────────────────┘
                                 │
          1. Deduplicate via `idempotency_keys` (returns 200 duplicate_ignored if seen)
          2. Write primary + fan-out child rows (`webhook_events`) to SQLite WAL
          3. Return HTTP 200 OK (`{"status": "queued"}`) & push to SSE Hub
                                 │
                                 ▼
             ┌───────────────────────────────────────┐
             │ internal/worker/worker.go (Pool)      │
             └───────────────────┬───────────────────┘
                                 ├──► Cryptographic verification (`internal/verifier`)
                                 ├──► Pre-flight circuit breaker (`CLOSED -> OPEN -> HALF_OPEN`)
                                 ├──► Optional Canonical Envelope + Standard Webhooks signing
                                 ├──► HTTP POST & latency timing logged to `delivery_logs`
                                 ├──► Retry-After (429/503) non-penalizing `DeferRetry`
                                 └──► 5-minute cooldown alerts (`internal/notifier`)
                                             │
                                             ▼
                               Control Plane API & Embedded React UI
```

---

## 1. Ingestion, Deduplication & Multi-Target Fan-Out

When a POST request arrives at `/ingest/{endpoint_id}` or `/v1/webhook/{endpoint_id}`:

1. `ingest.Handler` checks that the endpoint exists (`404`) and `is_active = true` (`400`), enforces a per-`(source_ip, endpoint_id)` rate limit (default 120 requests per 10 seconds), and reads up to `MaxPayloadBytes` (`10 MB`).
2. Spoofable internal headers (`X-User-Role`, `X-Admin`, `X-User-Email`, `X-User-Id`, `X-Forwarded-User`) are stripped before storage. If `Request-Target` is not present, the handler stores `r.URL.Path` under `X-RelayGate-Request-Target` so DOKU signature verification remains intact during background worker processing and later DLQ replays.
3. `model.ExtractIdempotencyKey` extracts an upstream delivery or transaction key in priority order:
   - Explicit headers: `X-GitHub-Delivery`, `X-Shopify-Webhook-Id`, `Request-Id`, `X-Request-Id`, `Idempotency-Key`, `Webhook-Id`.
   - Midtrans composite JSON keys: `midtrans:{order_id}:{status_code}:{transaction_status}` or `midtrans:{transaction_id}:{transaction_status}`.
   - DOKU nested keys: `doku:{order.invoice_number}:{transaction.status}` or `order.invoice_number`.
   - Generic JSON identifiers: top-level `id` or `external_id`.
4. Before inserting into `idempotency_keys`, RelayGate evaluates signatures if a non-empty signature was supplied. Requests carrying invalid signatures skip idempotency insertion (`allowDedup = false`) so unauthenticated callers cannot occupy valid delivery keys. Valid duplicate keys return `HTTP 200 OK` (`{"status": "duplicate_ignored", "event_id": existingID}`).
5. Destinations are resolved from `endpoint.Destinations` (falling back to `endpoint.TargetURL`). Destination `0` becomes the primary `WebhookEvent`, and destinations `1..N` become child `WebhookEvent` rows with `parent_event_id = event.ID` and independent `target_url` / `max_attempts`.

---

## 2. Cryptographic Verification Engines

`internal/verifier/verifier.go` evaluates signatures inside the worker pool (and prior to idempotency deduplication when signatures are present) using constant-time equality (`crypto/subtle.ConstantTimeCompare`):

| Provider | VerificationKind | Input & Algorithm | Replay Eligibility on Rejection |
| :--- | :--- | :--- | :--- |
| `stripe` | `hmac` | Extracts `t` and `v1` from `Stripe-Signature`; verifies `HMAC-SHA256(secret, "{t}.{raw_body}")` within 300s clock skew (`DefaultStripeTolerance`). | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING`, `SIGNATURE_TIMESTAMP_EXPIRED`, `SIGNATURE_TIMESTAMP_INVALID`. |
| `midtrans` | `hash` | Parses JSON with `UseNumber()`; computes `SHA-512(order_id + status_code + gross_amount + server_key)` against body `signature_key` or `X-Signature-Key` (tries exact, `.00`-suffixed, and `.00`-trimmed `gross_amount`). | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING` or `SIGNATURE_PAYLOAD_MALFORMED`. |
| `github` | `hmac` | Computes `HMAC-SHA256(secret, raw_body)` hex digest and compares against `X-Hub-Signature-256` (`sha256=` prefix stripped). | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING`. |
| `shopify` | `hmac` | Decodes Base64 (`StdEncoding` with `RawStdEncoding` fallback) from `X-Shopify-Hmac-Sha256` and compares raw HMAC-SHA256 digest bytes. | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING` or empty payload (`SIGNATURE_PAYLOAD_MALFORMED`). |
| `xendit` | `static_token` | Constant-time equality between `X-Callback-Token` and `secret_key`. | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING`. |
| `doku` | `hmac` | Verifies `Digest == "SHA-256=" + Base64(SHA256(raw_body))` and `Signature == "HMACSHA256=" + Base64(HMAC-SHA256(secret, "Client-Id:...\nRequest-Id:...\nRequest-Timestamp:...\nRequest-Target:...\nDigest:..."))` (`Request-Target` falls back to captured `X-RelayGate-Request-Target`). | Eligible on `SIGNATURE_MISMATCH`; ineligible on missing headers (`Client-Id`, `Request-Id`, `Request-Timestamp`, `Digest`, or `Signature`). |
| `flip` | `static_token` | Parses `token` from `application/x-www-form-urlencoded` body (falling back to `X-Callback-Token` / `X-Flip-Token`) and compares in constant time against `secret_key`. | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING` or empty payload (`SIGNATURE_PAYLOAD_MALFORMED`). |
| `generic` | `hmac` | Computes `HMAC-SHA256(secret, raw_body)` hex digest against `X-Signature-SHA256`, `X-Hub-Signature-256`, `X-Signature`, `Signature`, or `X-RelayGate-Signature` (`sha256=` or `sha256:` optional prefix). | Eligible on `SIGNATURE_MISMATCH`; ineligible on `SIGNATURE_HEADER_MISSING`. |

Note: If `provider == "generic"`, `wrap_envelope == true`, and inbound `signature` is empty, the worker skips inbound signature checks so `secret_key` acts strictly as the outbound Standard Webhooks signing secret.

---

## 3. Canonical Envelope & Worker Dispatch Pipeline

When processing a `PENDING` or `RETRYING` event, `worker.Pool` executes:

1. Guard in-flight concurrency via `inFlight` `sync.Map` so the retry scheduler and manual replay handlers cannot dispatch two concurrent HTTP requests for the same event ID.
2. Check circuit breaker state for `cbKey = endpoint.ID + "|" + targetURL`:
   - `circuitClosed`: allow immediate attempt.
   - `circuitOpen`: if `now < openUntil`, defer via `repo.DeferRetry` (`status = RETRYING`, `next_retry_at = openUntil`, `attempts` unchanged). Once `openUntil` passes, transition to `circuitHalfOpen` and admit a single probe request (`probeInFlight = true`).
3. If `endpoint.WrapEnvelope` is enabled, construct a `model.CanonicalEnvelope` (`event_type`, `external_id`, `amount`, `currency`, `raw_payload`), override `Content-Type: application/json`, inject `X-RelayGate-Event-Type` and `X-RelayGate-External-ID`, and append Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64_hmac_sha256>`).
4. Execute `http.Client.Do` (filtering hop-by-hop headers and internal `X-RelayGate-Request-Target`, adding `X-RelayGate-Delivery`, `X-RelayGate-Attempt`, `X-RelayGate-Provider`, `X-RelayGate-Verified`), measure `time.Since(startDelivery).Milliseconds()`, and persist a row into `delivery_logs`.
5. Classify the HTTP outcome:
   - `2xx`: call `recordCircuitSuccess(cbKey)` (returns circuit to `CLOSED`, resets failure count), mark `DELIVERED`.
   - `429` or `503` with `Retry-After`: `ParseRetryAfter` parses delta-seconds (clamped `2s..86400s`) or RFC HTTP-dates and calls `DeferRetry` so `attempts` is preserved for genuine downstream failures.
   - Network errors or `5xx`: increment `consecutiveFailures` on `cbKey`; on 5 consecutive failures (or a failed `HALF_OPEN` probe), trip circuit to `OPEN` for 60 seconds and dispatch incident notification via `notifier.Manager`.
   - Exhausted attempts (`attempts + 1 >= max_attempts`): transition event to `FAILED` (DLQ) and dispatch incident notification via `notifier.Manager`.

---

## 4. Storage Schema, Online Backup & Query Architecture

SQLite runs in WAL mode (`modernc.org/sqlite`) with periodic checkpoints every 30 seconds in `retrySchedulerLoop`:

| Table | Purpose & Key Columns |
| :--- | :--- |
| `endpoints` | Routing targets, `destinations_json`, `wrap_envelope`, `provider`, `secret_key`, and alert sinks (`notification_url`, `telegram_webhook`, `telegram_chat_id`, `discord_webhook`, `slack_webhook`, `notification_email`) |
| `webhook_events` | Primary and child (`parent_event_id`) event queue rows, raw header JSON, raw payload BLOB, `target_url`, `external_id`, `status`, `attempts`, `max_attempts`, `failure_code`, `failed_at`, `next_retry_at` |
| `delivery_logs` | Per-attempt telemetry rows (`id`, `event_id`, `attempt`, `status_code`, `duration_ms`, `error`, `created_at`) with foreign key `ON DELETE CASCADE` |
| `idempotency_keys` | Composite primary key `(endpoint_id, idempotency_key)` mapping to first-seen `event_id` |
| `users`, `sessions`, `email_verifications` | RBAC operator accounts, hashed session tokens, and 6-digit OTP registration challenges |
| `audit_reveals` | Immutable log of `?reveal=1` accesses storing event ID, admin user, IP address, and revealed header names only |

### Overview Aggregation & Online Snapshots

- `GET /api/v1/overview` calls `GetThroughput` (12 1-minute UTC buckets via SQL `GROUP BY`), `GetEndpointBreakdown` (aggregated status counters per endpoint via SQL `LEFT JOIN` and `GROUP BY`), and `GetRecentFailedEvents` (indexed `LIMIT 5` lookup hydrated with `delivery_logs`) without loading historical payload BLOBs into Go heap memory.
- `SQLiteRepository.Backup` uses an independent `backupMu` mutex (without holding the read/write transaction lock), checks `PRAGMA foreign_key_check;`, validates path confinement (no `..`, null bytes, drive roots, or OS system directories), and executes native SQLite `VACUUM INTO ?`.
- `PruneDeliveredEvents` runs hourly in `cmd/relaygate/main.go` when `RELAYGATE_RETENTION_DAYS > 0`, deleting `DELIVERED` rows older than the cutoff (cascading their `delivery_logs`) while strictly excluding `FAILED`, `PENDING`, and `RETRYING` rows.
