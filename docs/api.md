# RelayGate API Reference

RelayGate exposes a REST API for webhook ingestion, console authentication, event inspection, and dead-letter queue management.

All API routes (except ingestion and health) are prefixed with `/api/v1`.

---

## Authentication & Headers

* **Session Cookie:** Web console interactions use an `HttpOnly`, `SameSite=Strict` cookie (`relaygate_session`). State-mutating requests (`POST`, `PATCH`, `DELETE`) require valid browser `Origin` or `Sec-Fetch-Site` headers matching the server origin.
* **Bearer Token:** Automated clients or CLI tools can pass an `Authorization: Bearer <session_token>` header. Bearer token requests bypass CSRF checks.
* **Sensitive Header Masking:** Signature and credential headers (`Authorization`, `*Token*`, `*Signature*`, `*Secret*`, `Cookie`) are automatically masked as `••••••••` in event inspection responses unless explicitly audited with `?reveal=1`.

---

## Endpoint Summary

| Method | Path | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | None (Public) | Service health check and version verification |
| `POST` | `/ingest/{endpoint_id}` | Provider Signature | Ingest webhook payload into SQLite WAL queue (alias `/v1/webhook/{endpoint_id}`) |
| `POST` | `/api/v1/auth/register` | None (Public) | Register new operator account and send 6-digit email OTP |
| `POST` | `/api/v1/auth/verify` | None (Public) | Submit 6-digit OTP to activate account and receive session token |
| `POST` | `/api/v1/auth/resend-code` | None (Public) | Resend verification email code (rate limited) |
| `POST` | `/api/v1/auth/login` | None (Public) | Authenticate with email/password |
| `POST` | `/api/v1/auth/oauth` | None (Public) | Authenticate via OAuth identity provider |
| `POST` | `/api/v1/auth/logout` | Session / Bearer | Terminate active session and invalidate cookie |
| `GET` | `/api/v1/profile` | Session / Bearer | Fetch authenticated user profile details |
| `PATCH` | `/api/v1/profile` | Session / Bearer | Update account display name |
| `POST` | `/api/v1/profile/password` | Session / Bearer | Change account password |
| `POST` | `/api/v1/profile/avatar` | Session / Bearer | Upload custom avatar image (PNG, JPEG, WebP, max 2MB) |
| `DELETE` | `/api/v1/profile/avatar` | Session / Bearer | Remove custom avatar and revert to initial |
| `GET` | `/api/v1/stats` | Session / Bearer | Fetch aggregate KPI counters (total, delivered, pending, retrying, failed) |
| `GET` | `/api/v1/overview` | Session / Bearer | Fetch throughput buckets (1-min intervals) and recent delivery failures |
| `GET` | `/api/v1/events` | Session / Bearer | List webhook events with pagination and filters |
| `GET` | `/api/v1/events/{id}` | Session / Bearer | Fetch full event details with masked credential headers |
| `GET` | `/api/v1/events/{id}?reveal=1` | Session (`ADMIN`) | Audit and return unmasked raw headers (writes immutable audit record) |
| `POST` | `/api/v1/events/{id}/replay` | Session / Bearer | Reset attempts and enqueue immediate re-verification and delivery |
| `POST` | `/api/v1/events/bulk-replay` | Session / Bearer | Atomically enqueue all eligible `FAILED` events for replay |
| `GET` | `/api/v1/stream` | Session / Bearer | Real-time Server-Sent Events (SSE) feed of inbound events |
| `GET` | `/api/v1/endpoints` | Session / Bearer | List all configured webhook destination endpoints |
| `POST` | `/api/v1/endpoints` | Session (`ADMIN`) | Register a new destination endpoint |
| `PATCH` | `/api/v1/endpoints/{id}` | Session (`ADMIN`) | Update endpoint name, URL, provider, secret, or active status |
| `DELETE` | `/api/v1/endpoints/{id}` | Session (`ADMIN`) | Delete endpoint (blocked if active PENDING or RETRYING events exist) |

---

## Detailed Route Specifications

### 1. Ingest Webhook

```http
POST /ingest/{endpoint_id}
Host: 127.0.0.1:8080
Content-Type: application/json
X-Shopify-Hmac-Sha256: <base64_signature>

{"order_id": "ord_9901", "amount": 45000}
```

**Response (HTTP 202 Accepted):**
```json
{
  "status": "accepted",
  "event_id": "evt_3a10b9ff",
  "endpoint_id": "ep_shopify_orders"
}
```

* The payload and headers are written synchronously to SQLite WAL before responding.
* If the endpoint does not exist or is disabled (`is_active = 0`), returns `404 Not Found`.

---

### 2. Events & Dead-Letter Queue

#### List Events
```http
GET /api/v1/events?status=FAILED&provider=stripe&limit=25&page=1
```

Query Parameters:
* `status` (string, optional): `PENDING`, `RETRYING`, `DELIVERED`, `FAILED`.
* `provider` (string, optional): `generic`, `stripe`, `midtrans`, `github`, `xendit`, `shopify`.
* `endpoint_id` (string, optional): Filter by target endpoint ID.
* `failure_code` (string, optional): Filter by diagnosed failure cause.
* `search` (string, optional): Search by event ID, endpoint ID, or target URL.
* `page` (int, default 1): Page number.
* `limit` (int, default 50, max 100): Records per page.

#### Replay Event
```http
POST /api/v1/events/{id}/replay
```

* Resets `attempts` to 0.
* Transitions status back to `PENDING`.
* If the event was rejected due to an outdated secret key, rotating the secret in Endpoints and triggering replay re-verifies the payload against the new secret.
* Returns `409 Conflict` if the event is already in-flight or actively being delivered.

#### Bulk Replay
```http
POST /api/v1/events/bulk-replay
Content-Type: application/json

{}
```

**Response:**
```json
{
  "total_eligible": 14,
  "enqueued": 14,
  "skipped_ineligible": 3,
  "ineligible_breakdown": {
    "missing_signature_header": 2,
    "expired_timestamp": 1
  }
}
```

Events ineligible for replay (e.g. permanently malformed payloads or missing signatures) are skipped with an explicit breakdown.
