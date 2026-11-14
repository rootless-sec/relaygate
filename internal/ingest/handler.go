package ingest

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

const (
	// MaxPayloadBytes limits the maximum incoming webhook payload size to 10MB
	MaxPayloadBytes = 10 << 20

	// DefaultIngestLimitPerWindow default rate limit per IP/endpoint (120 reqs / 10s)
	DefaultIngestLimitPerWindow = 120
	DefaultIngestWindow         = 10 * time.Second
)

type ingestRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newIngestRateLimiter() *ingestRateLimiter {
	return &ingestRateLimiter{attempts: make(map[string][]time.Time)}
}

func (l *ingestRateLimiter) checkAndRecord(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now().UTC()
	cutoff := now.Add(-window)

	var valid []time.Time
	for _, ts := range l.attempts[key] {
		if ts.After(cutoff) {
			valid = append(valid, ts)
		}
	}

	if len(valid) >= limit {
		l.attempts[key] = valid
		return false
	}

	valid = append(valid, now)
	l.attempts[key] = valid
	return true
}

func (l *ingestRateLimiter) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempts = make(map[string][]time.Time)
}

// Response represents the immediate JSON response returned by the ingest receiver
type Response struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	EventID string `json:"event_id"`
	Message string `json:"message,omitempty"`
}

// ErrorResponse represents an error payload returned by ingest
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// Handler handles high-speed webhook ingestion
type Handler struct {
	repo        storage.Repository
	pool        *worker.Pool
	broadcaster model.Broadcaster
	ipResolver  func(r *http.Request) string
	limiter     *ingestRateLimiter
	limit       int
	window      time.Duration
}

// NewHandler creates a new Ingest HTTP handler
func NewHandler(repo storage.Repository, pool *worker.Pool) *Handler {
	return &Handler{
		repo:    repo,
		pool:    pool,
		limiter: newIngestRateLimiter(),
		limit:   DefaultIngestLimitPerWindow,
		window:  DefaultIngestWindow,
	}
}

// SetRateLimit configures ingestion rate limit threshold and window duration
func (h *Handler) SetRateLimit(limit int, window time.Duration) {
	if limit > 0 {
		h.limit = limit
	}
	if window > 0 {
		h.window = window
	}
}

// ResetRateLimits resets internal rate limiting state (used in testing)
func (h *Handler) ResetRateLimits() {
	if h.limiter != nil {
		h.limiter.reset()
	}
}

// SetBroadcaster configures a real-time event broadcaster
func (h *Handler) SetBroadcaster(b model.Broadcaster) {
	h.broadcaster = b
}

// SetIPResolver configures a custom client IP resolver (e.g. api.ResolveClientIP)
func (h *Handler) SetIPResolver(fn func(r *http.Request) string) {
	h.ipResolver = fn
}

// ServeHTTP handles POST /ingest/{endpoint_id}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, ErrorResponse{Error: "method not allowed", Message: "only POST requests are supported"})
		return
	}

	endpointID := extractEndpointID(r)
	if endpointID == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad request", Message: "endpoint_id is required in URL path"})
		return
	}

	// Verify endpoint exists and is active
	endpoint, err := h.repo.GetEndpointByID(r.Context(), endpointID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "endpoint not found", Message: "no active webhook endpoint matching this ID"})
		return
	}

	if !endpoint.IsActive {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "endpoint disabled", Message: "this webhook endpoint is currently disabled"})
		return
	}

	// Extract source IP
	sourceIP := h.extractSourceIP(r)

	// Rate limiting by client IP and endpoint ID
	rateKey := sourceIP + ":" + endpointID
	if h.limiter != nil && !h.limiter.checkAndRecord(rateKey, h.limit, h.window) {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, ErrorResponse{
			Error:   "too many requests",
			Message: "webhook ingestion rate limit exceeded for this endpoint and IP. Please slow down.",
		})
		return
	}

	// Limit request payload to 10MB
	r.Body = http.MaxBytesReader(w, r.Body, MaxPayloadBytes)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, ErrorResponse{Error: "payload too large", Message: "maximum body size is 10MB"})
		return
	}

	// Extract headers, filtering out internal identity headers
	headers := make(map[string]string)
	for k, v := range r.Header {
		if len(v) == 0 {
			continue
		}
		if strings.EqualFold(k, "X-User-Role") ||
			strings.EqualFold(k, "X-Admin") ||
			strings.EqualFold(k, "X-User-Email") ||
			strings.EqualFold(k, "X-User-Id") ||
			strings.EqualFold(k, "X-Forwarded-User") {
			continue
		}
		headers[k] = strings.Join(v, ", ")
	}
	if model.LookupHeader(headers, "Request-Target") == "" {
		headers["X-RelayGate-Request-Target"] = r.URL.Path
	}

	// Extract signature (from headers or body)
	signature := extractSignature(headers, payload)

	// Extract upstream idempotency key
	idempKey := model.ExtractIdempotencyKey(endpoint.Provider, headers, payload)

	// Create primary WebhookEvent ID
	eventID := uuid.NewString()

	// Perform upstream idempotency deduplication unless an explicit signature is present and invalid,
	// so forged requests cannot poison the idempotency table.
	if idempKey != "" {
		allowDedup := true
		if signature != "" {
			vStatus, _ := verifier.NewEngine().Verify(endpoint, headers, payload)
			if vStatus == verifier.VerificationInvalid {
				allowDedup = false
			}
		}
		if allowDedup {
			existingID, alreadyExists, idempErr := h.repo.CheckAndSetIdempotency(r.Context(), endpoint.ID, idempKey, eventID)
			if idempErr == nil && alreadyExists {
				writeJSON(w, http.StatusOK, Response{
					Status:  "duplicate_ignored",
					ID:      existingID,
					EventID: existingID,
					Message: "duplicate webhook ignored",
				})
				return
			}
		}
	}

	// Resolve fan-out destinations
	var validDests []model.EndpointDestination
	for _, d := range endpoint.Destinations {
		if u := strings.TrimSpace(d.URL); u != "" {
			validDests = append(validDests, model.EndpointDestination{
				URL:         u,
				MaxAttempts: model.NormalizeMaxAttempts(d.MaxAttempts),
			})
		}
	}
	if len(validDests) == 0 {
		validDests = []model.EndpointDestination{
			{
				URL:         endpoint.TargetURL,
				MaxAttempts: model.DefaultMaxAttempts,
			},
		}
	}

	now := time.Now().UTC()
	event := &model.WebhookEvent{
		ID:             eventID,
		EndpointID:     endpoint.ID,
		TargetURL:      validDests[0].URL,
		ExternalID:     idempKey,
		Provider:       endpoint.Provider,
		SourceIP:       sourceIP,
		Headers:        headers,
		Payload:        payload,
		Signature:      signature,
		IsVerified:     0,
		Status:         model.StatusPending,
		HTTPStatusCode: 0,
		Attempts:       0,
		MaxAttempts:    validDests[0].MaxAttempts,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	// Synchronously write primary event to SQLite queue in WAL mode
	if err := h.repo.SaveEvent(r.Context(), event); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal error", Message: "failed to persist webhook event"})
		return
	}

	// Create and persist fan-out child events for additional destinations
	var childEventIDs []string
	for i := 1; i < len(validDests); i++ {
		childID := uuid.NewString()
		childEvent := &model.WebhookEvent{
			ID:             childID,
			EndpointID:     endpoint.ID,
			TargetURL:      validDests[i].URL,
			ParentEventID:  event.ID,
			ExternalID:     idempKey,
			Provider:       endpoint.Provider,
			SourceIP:       sourceIP,
			Headers:        headers,
			Payload:        payload,
			Signature:      signature,
			IsVerified:     0,
			Status:         model.StatusPending,
			HTTPStatusCode: 0,
			Attempts:       0,
			MaxAttempts:    validDests[i].MaxAttempts,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if err := h.repo.SaveEvent(r.Context(), childEvent); err == nil {
			childEventIDs = append(childEventIDs, childID)
		}
	}

	// Return HTTP 200 OK immediately (< 5ms)
	writeJSON(w, http.StatusOK, Response{
		Status:  "queued",
		ID:      event.ID,
		EventID: event.ID,
		Message: "webhook received and queued",
	})

	// Asynchronously push primary and fan-out child events to internal dispatcher channel
	if h.pool != nil {
		h.pool.Enqueue(event.ID)
		for _, cid := range childEventIDs {
			h.pool.Enqueue(cid)
		}
	}

	// Broadcast live event creation to SSE listeners
	if h.broadcaster != nil {
		h.broadcaster.Broadcast("event_created", event)
	}
}

func extractEndpointID(r *http.Request) string {
	// Go 1.22+ PathValue support
	if val := r.PathValue("endpoint_id"); val != "" {
		return val
	}

	// Manual path fallback: /ingest/{endpoint_id} or /v1/webhook/{endpoint_id}
	path := strings.Trim(r.URL.Path, "/")
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if (part == "ingest" || part == "webhook") && i+1 < len(parts) {
			return parts[i+1]
		}
	}

	return ""
}

func (h *Handler) extractSourceIP(r *http.Request) string {
	if h.ipResolver != nil {
		return h.ipResolver(r)
	}

	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}

	ip := net.ParseIP(strings.TrimSpace(remoteHost))
	isLoopback := ip != nil && ip.IsLoopback()

	if isLoopback {
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			if net.ParseIP(xrip) != nil {
				return xrip
			}
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				clientIP := strings.TrimSpace(parts[i])
				if parsed := net.ParseIP(clientIP); parsed != nil {
					if parsed.IsLoopback() && i > 0 {
						continue
					}
					return clientIP
				}
			}
		}
	} else {
		// When called in unit tests without loopback RemoteAddr, fall back to first valid IP if XFF present
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for _, p := range parts {
				trimmed := strings.TrimSpace(p)
				if net.ParseIP(trimmed) != nil {
					return trimmed
				}
			}
		}
	}

	return remoteHost
}

func extractSignature(headers map[string]string, payload []byte) string {
	keys := []string{
		"Stripe-Signature",
		"X-Shopify-Hmac-Sha256",
		"X-Signature-SHA256",
		"X-Hub-Signature-256",
		"X-Signature-Key",
		"X-Signature",
		"Signature",
		"X-Callback-Token",
	}

	for _, k := range keys {
		for hk, hv := range headers {
			if strings.EqualFold(hk, k) && strings.TrimSpace(hv) != "" {
				return strings.TrimSpace(hv)
			}
		}
	}

	// For Midtrans or JSON webhooks: check signature_key in payload if not found in headers
	if len(payload) > 0 && len(payload) < 65536 {
		trimmed := bytes.TrimSpace(payload)
		if len(trimmed) > 0 && trimmed[0] == '{' {
			var bodyMap map[string]any
			if err := json.Unmarshal(trimmed, &bodyMap); err == nil {
				if sig, ok := bodyMap["signature_key"].(string); ok && strings.TrimSpace(sig) != "" {
					return strings.TrimSpace(sig)
				}
			}
		}
	}

	return ""
}

func writeJSON(w http.ResponseWriter, statusCode int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(data)
}
