package ingest

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/worker"
)

const (
	// MaxPayloadBytes limits the maximum incoming webhook payload size to 10MB
	MaxPayloadBytes = 10 << 20
)

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
}

// NewHandler creates a new Ingest HTTP handler
func NewHandler(repo storage.Repository, pool *worker.Pool) *Handler {
	return &Handler{
		repo: repo,
		pool: pool,
	}
}

// SetBroadcaster configures a real-time event broadcaster
func (h *Handler) SetBroadcaster(b model.Broadcaster) {
	h.broadcaster = b
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

	// Limit request payload to 10MB
	r.Body = http.MaxBytesReader(w, r.Body, MaxPayloadBytes)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, ErrorResponse{Error: "payload too large", Message: "maximum body size is 10MB"})
		return
	}

	// Extract headers
	headers := make(map[string]string)
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[k] = strings.Join(v, ", ")
		}
	}

	// Extract signature (from headers or body)
	signature := extractSignature(headers, payload)

	// Extract source IP
	sourceIP := extractSourceIP(r)

	// Create WebhookEvent
	eventID := uuid.NewString()
	now := time.Now().UTC()
	event := &model.WebhookEvent{
		ID:             eventID,
		EndpointID:     endpoint.ID,
		Provider:       endpoint.Provider,
		SourceIP:       sourceIP,
		Headers:        headers,
		Payload:        payload,
		Signature:      signature,
		IsVerified:     0,
		Status:         model.StatusPending,
		HTTPStatusCode: 0,
		Attempts:       0,
		MaxAttempts:    5,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	// Synchronously write to SQLite queue in WAL mode
	if err := h.repo.SaveEvent(r.Context(), event); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal error", Message: "failed to persist webhook event"})
		return
	}

	// Return HTTP 200 OK immediately (< 5ms)
	writeJSON(w, http.StatusOK, Response{
		Status:  "queued",
		ID:      event.ID,
		EventID: event.ID,
		Message: "webhook received and queued",
	})

	// Asynchronously push to internal dispatcher channel
	if h.pool != nil {
		h.pool.Enqueue(event.ID)
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

	// Manual path fallback: /ingest/{endpoint_id}
	path := strings.Trim(r.URL.Path, "/")
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part == "ingest" && i+1 < len(parts) {
			return parts[i+1]
		}
	}

	return ""
}

func extractSourceIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return ip
	}
	return r.RemoteAddr
}

func extractSignature(headers map[string]string, payload []byte) string {
	keys := []string{
		"Stripe-Signature",
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
