# RelayGate API Reference

RelayGate exposes a REST API and an SSE stream for webhook ingestion, session management, endpoint configuration, event inspection, dead-letter replay, and online database maintenance. Management routes are prefixed with `/api/v1`.

---

## Authentication, CSRF & Data Masking

| Mechanism | Behavior |
| :--- | :--- |
| Session cookie | Browser logins set an `HttpOnly`, `SameSite=Strict` cookie named `session`. Cookie-authenticated `POST`, `PATCH`, `PUT`, `DELETE`, and `?reveal=1` requests validate `Sec-Fetch-Site`, `Origin`, or `Referer` against the server host and `RELAYGATE_ALLOWED_ORIGINS`. |
| Bearer token | Automated clients can send `Authorization: Bearer <session_token>` or `?token=<session_token>` (useful for SSE). Bearer authentication skips cookie CSRF origin checks. |
| Header and body masking | Event inspection responses replace sensitive headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Callback-Token`, `X-Api-Key`, `Stripe-Signature`, `X-Shopify-Hmac-Sha256`, `X-Hub-Signature*`, and any key containing `token`, `secret`, `signature`, `auth`, `password`, `key`, or `cookie`) with `••••••••••••••••••••••••••••••••`. Flip form payloads have their `token` parameter replaced with `••••••••`, and Flip/Xendit `signature` fields are masked by default. |
| Audit reveal (`?reveal=1`) | Passing `?reveal=1` or `?reveal=true` requires an `admin` session and writes a record containing the operator identity, client IP, and unmasked header names (never header values) into `audit_reveals` before returning unmasked data. If persisting the audit row fails, the request fails closed with HTTP `500`. |

---

## Endpoint Summary

| Method | Path | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | None | Returns service health status, UTC timestamp, and version |
| `POST` | `/ingest/{endpoint_id}` | Provider Signature | Persists inbound webhook in SQLite WAL and queues delivery (alias `/v1/webhook/{endpoint_id}`) |
| `POST` | `/api/v1/auth/register` | None | Creates pending registration and issues a 6-digit OTP via SMTP or dev log |
| `POST` | `/api/v1/auth/verify` | None | Verifies 6-digit OTP, creates user (first user becomes `admin`), sets session cookie |
| `POST` | `/api/v1/auth/resend-code` | None | Re-sends OTP verification code (rate limited per email and IP) |
| `POST` | `/api/v1/auth/login` | None | Authenticates user with email and password |
| `POST` | `/api/v1/auth/oauth` | None | Authenticates or registers via OAuth (`google`, `github`, `gitlab`) |
| `POST` | `/api/v1/auth/logout` | Session / Bearer | Deletes active session and clears `session` cookie |
| `GET` | `/api/v1/profile` | Session / Bearer | Returns authenticated user profile |
| `PATCH` | `/api/v1/profile` | Session / Bearer | Updates display name |
| `POST` | `/api/v1/profile/password` | Session / Bearer | Updates password after verifying current password |
| `POST` | `/api/v1/profile/avatar` | Session / Bearer | Uploads custom avatar image (PNG, JPEG, WebP, max 2 MB) |
| `DELETE` | `/api/v1/profile/avatar` | Session / Bearer | Deletes uploaded avatar |
| `GET` | `/api/v1/profile/avatar/{filename}` | None | Serves stored avatar image with sandbox CSP headers |
| `GET` | `/api/v1/stats` | Session / Bearer | Returns aggregate counters (`total_events`, `delivered_events`, `pending_events`, `retrying_events`, `failed_events`) |
| `GET` | `/api/v1/overview` | Session / Bearer | Returns stats, 12-minute SQL throughput buckets, per-endpoint breakdowns, and top 5 recent failures |
| `GET` | `/api/v1/events` | Session / Bearer | Lists paginated events with filter parameters and hydrated `delivery_log` entries |
| `GET` | `/api/v1/events/{id}` | Session / Bearer | Returns single event details, masked payload/headers, and `delivery_log` attempt timeline |
| `GET` | `/api/v1/events/{id}?reveal=1` | Session / Bearer (`admin`) | Returns unmasked headers/tokens and records an `audit_reveals` entry |
| `POST` | `/api/v1/events/{id}/replay` | Session / Bearer | Resets circuit breaker, sets attempts to 0, queues immediate replay (including failed fan-out children) |
| `POST` | `/api/v1/events/bulk-replay` | Session / Bearer | Replays eligible `FAILED` events and returns skipped reasons for ineligible rows |
| `GET` | `/api/v1/stream` | Session / Bearer | Real-time Server-Sent Events (SSE) stream (`event_created`, `event_updated`) |
| `GET` | `/api/v1/endpoints` | Session / Bearer | Lists configured endpoints |
| `POST` | `/api/v1/endpoints` | Session / Bearer | Registers a new endpoint with optional fan-out destinations, canonical envelope, and alert channels |
| `PATCH` | `/api/v1/endpoints/{id}` | Session / Bearer | Updates endpoint settings, secret key, destinations, or notification channels |
| `DELETE` | `/api/v1/endpoints/{id}` | Session / Bearer (`admin`) | Deletes an endpoint (returns `409 Conflict` if `PENDING` or `RETRYING` events exist) |
| `POST` | `/api/v1/system/backup` | Session / Bearer (`admin`) | Executes online SQLite `VACUUM INTO` snapshot after `PRAGMA foreign_key_check` |
| `POST` | `/api/v1/system/retention/prune` | Session / Bearer (`admin`) | Prunes `DELIVERED` events older than `cutoff` (defaults to 30 days) while preserving `FAILED` rows |

---

## Route Specifications

### 1. Ingest Webhook

```http
POST /ingest/{endpoint_id}
Host: 127.0.0.1:8080
Content-Type: application/json
X-Shopify-Hmac-Sha256: <base64_signature>

{"id": "evt_ord_9901", "amount": 45000}
```

**Queued Response (HTTP `200 OK`):**

```json
{
  "status": "queued",
  "id": "a7f3c8b2-1d4e-4b9a-9c3a-5f8d0e1a2b3c",
  "event_id": "a7f3c8b2-1d4e-4b9a-9c3a-5f8d0e1a2b3c",
  "message": "webhook received and queued"
}
```

**Duplicate Delivery Response (HTTP `200 OK`):**

When `model.ExtractIdempotencyKey` finds an existing `(endpoint_id, idempotency_key)` entry in `idempotency_keys` (and the request does not fail an explicit signature check), ingest skips creating a new queue item and returns:

```json
{
  "status": "duplicate_ignored",
  "id": "a7f3c8b2-1d4e-4b9a-9c3a-5f8d0e1a2b3c",
  "event_id": "a7f3c8b2-1d4e-4b9a-9c3a-5f8d0e1a2b3c",
  "message": "duplicate webhook ignored"
}
```

Error status codes at ingest:
1. `404 Not Found` if `endpoint_id` does not exist.
2. `400 Bad Request` if the endpoint has `is_active = false`.
3. `413 Request Entity Too Large` if payload exceeds `10 MB`.
4. `429 Too Many Requests` (`Retry-After: 1`) if the per-IP/endpoint rate limit (default 120 requests per 10s) is exceeded.

---

### 2. Endpoints Configuration (`POST /api/v1/endpoints` and `PATCH /api/v1/endpoints/{id}`)

```json
{
  "name": "Midtrans Payment Fan-Out",
  "provider": "midtrans",
  "target_url": "https://billing.internal/webhooks/midtrans",
  "target_urls": [
    "https://billing.internal/webhooks/midtrans",
    "https://analytics.internal/events/payment"
  ],
  "destinations": [
    {"url": "https://billing.internal/webhooks/midtrans", "max_attempts": 5},
    {"url": "https://analytics.internal/events/payment", "max_attempts": 3}
  ],
  "wrap_envelope": true,
  "secret_key": "whsec_your_provider_or_outbound_secret",
  "notification_url": "https://ops.internal/hooks/relaygate",
  "telegram_webhook": "https://api.telegram.org/bot<TOKEN>/sendMessage",
  "telegram_chat_id": "-1001234567890",
  "discord_webhook": "https://discord.com/api/webhooks/...",
  "slack_webhook": "https://hooks.slack.com/services/...",
  "notification_email": "oncall@example.com"
}
```

Field notes:
1. Valid `provider` values are `generic`, `stripe`, `midtrans`, `github`, `xendit`, `shopify`, `doku`, and `flip`. Empty defaults to `generic`.
2. When omitted on `POST /api/v1/endpoints`, `secret_key` is auto-generated as `whsec_<64 hex chars>`. Explicitly supplied secrets must be at least 8 printable characters.
3. If `destinations` is provided, each entry must be an `http://` or `https://` URL with an optional `max_attempts` override (defaults to `5`). `target_urls` acts as a shorthand array of destination URLs when `max_attempts` customization is not needed.
4. Both `notification_email` and alias `notify_email` are accepted in JSON requests.

---

### 3. Events, Telemetry & Dead-Letter Queue

#### List Events

```http
GET /api/v1/events?status=FAILED&provider=doku&failure_code=SIGNATURE_MISMATCH&limit=25&page=1
```

Query parameters:

| Parameter | Values / Default | Behavior |
| :--- | :--- | :--- |
| `status` | `PENDING`, `RETRYING`, `DELIVERED`, `FAILED` | Filters by lifecycle status |
| `provider` | `generic`, `stripe`, `midtrans`, `github`, `xendit`, `shopify`, `doku`, `flip` | Filters by endpoint provider |
| `endpoint_id` | Endpoint ID string | Filters by source endpoint |
| `failure_code` | `SIGNATURE_HEADER_MISSING`, `SIGNATURE_MISMATCH`, `SIGNATURE_TIMESTAMP_EXPIRED`, `SIGNATURE_TIMESTAMP_INVALID`, `SIGNATURE_PAYLOAD_MALFORMED`, `TIMEOUT`, `HTTP_5XX`, `HTTP_4XX`, `NETWORK_ERROR`, `DELIVERY_FAILED` | Filters by structured failure reason (matches stored `failure_code` or legacy inferred codes) |
| `search` / `q` | Search string | Matches `id`, `endpoint_id`, `target_url`, `external_id`, `parent_event_id`, or `last_error` |
| `page` | Integer (default `1`) | 1-based page offset |
| `limit` | Integer (default `50`, max `500`) | Maximum rows returned per page |

Each item in `events` (and responses from `GET /api/v1/events/{id}`) includes `target_url`, `parent_event_id`, `external_id`, `error_class`, `error_code`, `failure_code`, `verification_kind` (`hmac`, `hash`, `static_token`), `payload_raw`, optional `payload_json`, and `delivery_log`:

```json
{
  "attempt": 1,
  "code": 503,
  "ms": 142,
  "err": "downstream returned HTTP 503: upstream maintenance",
  "t": "2026-11-15T00:12:04Z"
}
```

#### Replay Single Event

```http
POST /api/v1/events/{id}/replay
```

Behavior on replay:
1. Acquires a per-event mutex (`KeyedMutex`); concurrent replays or events currently `PENDING` / `RETRYING` return `409 Conflict`.
2. Calls `event.IsEligibleForReplay()`. Events failed with `SIGNATURE_HEADER_MISSING`, `SIGNATURE_TIMESTAMP_EXPIRED`, `SIGNATURE_TIMESTAMP_INVALID`, `SIGNATURE_PAYLOAD_MALFORMED`, or `PAYLOAD_CORRUPT` return `400 Bad Request`.
3. Resets `attempts` to `0`, clears error fields, resets open circuit breakers on `endpoint_id`, sets `status = PENDING`, and re-queues the event. If `id` is a parent fan-out event, any eligible `FAILED` child fan-out events are also queued without re-sending already delivered siblings.

#### Bulk Replay

```http
POST /api/v1/events/bulk-replay
Content-Type: application/json

{
  "all_failed": true,
  "endpoint_id": "ep_midtrans_01"
}
```

Or pass `"ids": ["evt_1", "evt_2"]` (capped at 1000 events per call).

**Response (`HTTP 200 OK`):**

```json
{
  "eligible_count": 14,
  "replayed_count": 14,
  "skipped_count": 3,
  "skipped_breakdown": {
    "SIGNATURE_HEADER_MISSING": 2,
    "SIGNATURE_TIMESTAMP_EXPIRED": 1
  }
}
```

---

### 4. System Maintenance (`ADMIN` Only)

#### Online Hot Backup (`POST /api/v1/system/backup`)

Requires an active `admin` session. Runs `PRAGMA foreign_key_check;` followed by `VACUUM INTO ?` under an independent `backupMu` lock so active webhook ingestion and dispatch continue uninterrupted.

Request body (optional; defaults to `data/backups/relaygate_backup_<YYYYMMDD_HHMMSS>.db`):

```json
{
  "destination_path": "data/backups/manual_snapshot.db"
}
```

Paths containing `..`, null bytes, system directories, root directories, or targets outside the working directory or OS temp directory are rejected with `400 Bad Request`.

**Response (`HTTP 200 OK`):**

```json
{
  "destination_path": "C:\\path\\to\\relaygate\\data\\backups\\manual_snapshot.db",
  "size_bytes": 167936,
  "duration_ms": 14,
  "created_at": "2026-11-15T00:15:00Z"
}
```

#### Retention Prune (`POST /api/v1/system/retention/prune`)

Requires an `admin` session. Deletes `DELIVERED` events older than `cutoff` (RFC3339 timestamp; defaults to 30 days ago) while preserving `FAILED` (DLQ), `PENDING`, and `RETRYING` records.

```json
{
  "cutoff": "2026-10-15T00:00:00Z"
}
```

**Response (`HTTP 200 OK`):**

```json
{
  "pruned": 42
}
```
