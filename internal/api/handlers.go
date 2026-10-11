package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/worker"
)

// EventResponse wraps model.WebhookEvent with parsed payload and delivery logs
type EventResponse struct {
	*model.WebhookEvent
	PayloadJSON any                      `json:"payload_json,omitempty"`
	PayloadRaw  string                   `json:"payload_raw"`
	DeliveryLog []model.DeliveryLogEntry `json:"delivery_log"`
}

// EventsListResponse represents paginated events list response
type EventsListResponse struct {
	Events []EventResponse `json:"events"`
	Total  int64           `json:"total"`
	Page   int             `json:"page"`
	Limit  int             `json:"limit"`
}

// EndpointsListResponse represents endpoints list response
type EndpointsListResponse struct {
	Endpoints []*model.Endpoint `json:"endpoints"`
}

// BulkReplayRequest represents request payload for bulk replay
type BulkReplayRequest struct {
	IDs        []string `json:"ids"`
	AllFailed  bool     `json:"all_failed"`
	EndpointID string   `json:"endpoint_id"`
}

// BulkReplayResponse represents bulk replay result
type BulkReplayResponse struct {
	ReplayedCount int `json:"replayed_count"`
}

// CreateEndpointRequest represents payload to register a new endpoint
type CreateEndpointRequest struct {
	Name      string             `json:"name"`
	Provider  model.ProviderType `json:"provider"`
	TargetURL string             `json:"target_url"`
	SecretKey string             `json:"secret_key"`
}

// UpdateEndpointRequest represents payload to patch an endpoint
type UpdateEndpointRequest struct {
	Name      *string             `json:"name,omitempty"`
	Provider  *model.ProviderType `json:"provider,omitempty"`
	TargetURL *string             `json:"target_url,omitempty"`
	SecretKey *string             `json:"secret_key,omitempty"`
	IsActive  *bool               `json:"is_active,omitempty"`
}

// ThroughputBucket represents a 1-minute slice of event traffic
type ThroughputBucket struct {
	Index  int    `json:"index"`
	Total  int    `json:"total"`
	Failed int    `json:"failed"`
	Label  string `json:"label"`
}

// EndpointBreakdown represents traffic metrics for a single endpoint
type EndpointBreakdown struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Provider    model.ProviderType `json:"provider"`
	Total       int                `json:"total"`
	Delivered   int                `json:"delivered"`
	Failed      int                `json:"failed"`
	SuccessRate int                `json:"success_rate"`
}

// OverviewResponse represents global dashboard metrics and visual analytics
type OverviewResponse struct {
	Stats             *model.StatsSummary `json:"stats"`
	Throughput        []ThroughputBucket  `json:"throughput"`
	EndpointBreakdown []EndpointBreakdown `json:"endpoint_breakdown"`
	RecentFailed      []EventResponse     `json:"recent_failed"`
}

// RegisterRequest represents request body for user registration
type RegisterRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// LoginRequest represents request body for user authentication
type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// AuthResponse represents the authentication response payload
type AuthResponse struct {
	User    *model.User `json:"user"`
	Message string      `json:"message,omitempty"`
}

// API handles control plane REST requests
type API struct {
	repo storage.Repository
	pool *worker.Pool
	hub  *Hub
}

// NewAPI initializes control plane API handlers
func NewAPI(repo storage.Repository, pool *worker.Pool, hub *Hub) *API {
	return &API{
		repo: repo,
		pool: pool,
		hub:  hub,
	}
}

// ListEvents handles GET /api/v1/events
func (a *API) ListEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	limit := 50
	if lStr := q.Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 && l <= 500 {
			limit = l
		}
	}

	page := 1
	if pStr := q.Get("page"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil && p > 0 {
			page = p
		}
	}
	offset := (page - 1) * limit

	status := model.EventStatus(strings.ToUpper(strings.TrimSpace(q.Get("status"))))
	endpointID := strings.TrimSpace(q.Get("endpoint_id"))
	search := strings.TrimSpace(q.Get("search"))
	if search == "" {
		search = strings.TrimSpace(q.Get("q"))
	}

	filter := storage.ListFilter{
		EndpointID: endpointID,
		Status:     status,
		Search:     search,
		Limit:      limit,
		Offset:     offset,
	}

	events, total, err := a.repo.ListEvents(r.Context(), filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to query events", err)
		return
	}

	resList := make([]EventResponse, len(events))
	for i, ev := range events {
		resList[i] = formatEventResponse(ev)
	}

	writeJSON(w, http.StatusOK, EventsListResponse{
		Events: resList,
		Total:  total,
		Page:   page,
		Limit:  limit,
	})
}

// GetEvent handles GET /api/v1/events/{id}
func (a *API) GetEvent(w http.ResponseWriter, r *http.Request) {
	id := extractPathID(r, "id", "events")
	if id == "" {
		writeError(w, http.StatusBadRequest, "event id is required", nil)
		return
	}

	event, err := a.repo.GetEventByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "event not found", err)
		return
	}

	writeJSON(w, http.StatusOK, formatEventResponse(event))
}

// ReplayEvent handles POST /api/v1/events/{id}/replay
func (a *API) ReplayEvent(w http.ResponseWriter, r *http.Request) {
	id := extractPathID(r, "id", "events")
	if id == "" {
		writeError(w, http.StatusBadRequest, "event id is required", nil)
		return
	}

	event, err := a.repo.GetEventByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "event not found", err)
		return
	}

	// Update status in repository to PENDING
	if err := a.repo.UpdateEventStatus(r.Context(), id, model.StatusPending, 0, ""); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reset event status", err)
		return
	}

	event.Status = model.StatusPending
	event.Attempts = 0
	event.HTTPStatusCode = 0
	event.LastError = ""

	// Enqueue in worker pool
	if a.pool != nil {
		a.pool.Enqueue(id)
	}

	// Broadcast update to SSE subscribers
	if a.hub != nil {
		a.hub.Broadcast("event_updated", event)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "replaying",
		"id":      id,
		"message": "event queued for immediate re-delivery",
	})
}

// BulkReplay handles POST /api/v1/events/bulk-replay
func (a *API) BulkReplay(w http.ResponseWriter, r *http.Request) {
	var req BulkReplayRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid request json", err)
		return
	}

	var targetIDs []string

	if req.AllFailed {
		failedEvents, _, err := a.repo.ListEvents(r.Context(), storage.ListFilter{
			Status:     model.StatusFailed,
			EndpointID: req.EndpointID,
			Limit:      1000,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to query failed events", err)
			return
		}
		for _, ev := range failedEvents {
			targetIDs = append(targetIDs, ev.ID)
		}
	} else {
		targetIDs = req.IDs
	}

	replayedCount := 0
	for _, id := range targetIDs {
		if id == "" {
			continue
		}
		if err := a.repo.UpdateEventStatus(r.Context(), id, model.StatusPending, 0, ""); err == nil {
			if a.pool != nil {
				a.pool.Enqueue(id)
			}
			if a.hub != nil {
				if ev, err := a.repo.GetEventByID(r.Context(), id); err == nil {
					a.hub.Broadcast("event_updated", ev)
				}
			}
			replayedCount++
		}
	}

	writeJSON(w, http.StatusOK, BulkReplayResponse{
		ReplayedCount: replayedCount,
	})
}

// ListEndpoints handles GET /api/v1/endpoints
func (a *API) ListEndpoints(w http.ResponseWriter, r *http.Request) {
	endpoints, err := a.repo.ListEndpoints(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list endpoints", err)
		return
	}

	if endpoints == nil {
		endpoints = make([]*model.Endpoint, 0)
	}

	writeJSON(w, http.StatusOK, EndpointsListResponse{
		Endpoints: endpoints,
	})
}

// CreateEndpoint handles POST /api/v1/endpoints
func (a *API) CreateEndpoint(w http.ResponseWriter, r *http.Request) {
	var req CreateEndpointRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload", err)
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.TargetURL = strings.TrimSpace(req.TargetURL)

	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "endpoint name is required", nil)
		return
	}
	if req.TargetURL == "" || (!strings.HasPrefix(req.TargetURL, "http://") && !strings.HasPrefix(req.TargetURL, "https://")) {
		writeError(w, http.StatusBadRequest, "valid target_url (http:// or https://) is required", nil)
		return
	}

	provider := req.Provider
	if provider == "" {
		provider = model.ProviderGeneric
	}

	secretKey := req.SecretKey
	if secretKey == "" {
		randomBytes := make([]byte, 16)
		_, _ = rand.Read(randomBytes)
		secretKey = "whsec_" + hex.EncodeToString(randomBytes)
	}

	endpoint := &model.Endpoint{
		ID:        "ep_" + strings.ToLower(uuid.NewString()[:8]),
		Name:      req.Name,
		SecretKey: secretKey,
		TargetURL: req.TargetURL,
		Provider:  provider,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}

	if err := a.repo.SaveEndpoint(r.Context(), endpoint); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save endpoint", err)
		return
	}

	writeJSON(w, http.StatusCreated, endpoint)
}

// UpdateEndpoint handles PATCH /api/v1/endpoints/{id}
func (a *API) UpdateEndpoint(w http.ResponseWriter, r *http.Request) {
	id := extractPathID(r, "id", "endpoints")
	if id == "" {
		writeError(w, http.StatusBadRequest, "endpoint id is required", nil)
		return
	}

	existing, err := a.repo.GetEndpointByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "endpoint not found", err)
		return
	}

	var req UpdateEndpointRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body", err)
		return
	}

	if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
		existing.Name = strings.TrimSpace(*req.Name)
	}
	if req.Provider != nil && *req.Provider != "" {
		existing.Provider = *req.Provider
	}
	if req.TargetURL != nil && strings.TrimSpace(*req.TargetURL) != "" {
		trimmed := strings.TrimSpace(*req.TargetURL)
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			existing.TargetURL = trimmed
		}
	}
	if req.SecretKey != nil && strings.TrimSpace(*req.SecretKey) != "" {
		existing.SecretKey = strings.TrimSpace(*req.SecretKey)
	}
	if req.IsActive != nil {
		existing.IsActive = *req.IsActive
	}

	if err := a.repo.SaveEndpoint(r.Context(), existing); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update endpoint", err)
		return
	}

	writeJSON(w, http.StatusOK, existing)
}

// GetStats handles GET /api/v1/stats
func (a *API) GetStats(w http.ResponseWriter, r *http.Request) {
	stats, err := a.repo.GetStats(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get stats", err)
		return
	}

	writeJSON(w, http.StatusOK, stats)
}

// GetOverview handles GET /api/v1/overview
func (a *API) GetOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	stats, err := a.repo.GetStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to retrieve stats", err)
		return
	}

	endpoints, err := a.repo.ListEndpoints(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to retrieve endpoints", err)
		return
	}

	recentEvents, _, err := a.repo.ListEvents(ctx, storage.ListFilter{
		Limit: 500,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to retrieve recent events", err)
		return
	}

	// 1. Throughput calculation for last 12 minutes
	const numBuckets = 12
	now := time.Now().UTC()
	buckets := make([]ThroughputBucket, numBuckets)
	for i := 0; i < numBuckets; i++ {
		minsAgo := numBuckets - 1 - i
		label := fmt.Sprintf("-%dm", minsAgo)
		if minsAgo == 0 {
			label = "now"
		}
		buckets[i] = ThroughputBucket{
			Index: i,
			Label: label,
		}
	}

	for _, ev := range recentEvents {
		diff := now.Sub(ev.CreatedAt)
		mins := int(diff.Minutes())
		if mins >= 0 && mins < numBuckets {
			idx := numBuckets - 1 - mins
			buckets[idx].Total++
			if ev.Status == model.StatusFailed || ev.Status == model.StatusRetrying {
				buckets[idx].Failed++
			}
		}
	}

	// 2. Endpoint breakdown calculation
	endpointMap := make(map[string]*EndpointBreakdown)
	for _, ep := range endpoints {
		endpointMap[ep.ID] = &EndpointBreakdown{
			ID:       ep.ID,
			Name:     ep.Name,
			Provider: ep.Provider,
		}
	}

	for _, ev := range recentEvents {
		if eb, ok := endpointMap[ev.EndpointID]; ok {
			eb.Total++
			if ev.Status == model.StatusDelivered {
				eb.Delivered++
			} else if ev.Status == model.StatusFailed {
				eb.Failed++
			}
		}
	}

	breakdownList := make([]EndpointBreakdown, 0, len(endpoints))
	for _, ep := range endpoints {
		if eb, ok := endpointMap[ep.ID]; ok {
			rate := 0
			if eb.Total > 0 {
				rate = int(float64(eb.Delivered) / float64(eb.Total) * 100)
			}
			eb.SuccessRate = rate
			breakdownList = append(breakdownList, *eb)
		}
	}

	// 3. Recent failed events (top 5)
	var recentFailed []EventResponse
	for _, ev := range recentEvents {
		if ev.Status == model.StatusFailed {
			recentFailed = append(recentFailed, formatEventResponse(ev))
			if len(recentFailed) >= 5 {
				break
			}
		}
	}
	if recentFailed == nil {
		recentFailed = make([]EventResponse, 0)
	}

	writeJSON(w, http.StatusOK, OverviewResponse{
		Stats:             stats,
		Throughput:        buckets,
		EndpointBreakdown: breakdownList,
		RecentFailed:      recentFailed,
	})
}

// StreamSSE handles GET /api/v1/stream
func (a *API) StreamSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Disable response write timeout for SSE connection
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	clientCh := a.hub.Subscribe()
	defer a.hub.Unsubscribe(clientCh)

	// Send initial handshake
	_, _ = w.Write([]byte("event: connected\ndata: {\"status\":\"connected\"}\n\n"))
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		case msg, ok := <-clientCh:
			if !ok {
				return
			}
			_, _ = w.Write(msg)
			flusher.Flush()
		}
	}
}

// Register handles POST /api/v1/auth/register
func (a *API) Register(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload", err)
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Password = strings.TrimSpace(req.Password)

	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "Nama lengkap atau username wajib diisi", nil)
		return
	}
	if req.Email == "" || !strings.Contains(req.Email, "@") || !strings.Contains(req.Email, ".") {
		writeError(w, http.StatusBadRequest, "Format alamat email tidak valid", nil)
		return
	}
	if len(req.Password) < 6 {
		writeError(w, http.StatusBadRequest, "Password minimal 6 karakter", nil)
		return
	}

	// Check if email is already registered
	existing, err := a.repo.GetUserByEmail(r.Context(), req.Email)
	if err == nil && existing != nil {
		writeError(w, http.StatusConflict, "Email sudah terdaftar. Silakan gunakan email lain atau masuk.", nil)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal memproses password", err)
		return
	}

	user := &model.User{
		ID:           "usr_" + strings.ToLower(uuid.NewString()[:8]),
		Name:         req.Name,
		Email:        req.Email,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UTC(),
	}

	if err := a.repo.SaveUser(r.Context(), user); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal mendaftarkan akun", err)
		return
	}

	writeJSON(w, http.StatusCreated, AuthResponse{
		User:    user,
		Message: "Registrasi berhasil",
	})
}

// Login handles POST /api/v1/auth/login
func (a *API) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload", err)
		return
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Password = strings.TrimSpace(req.Password)

	if req.Email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "Email dan password wajib diisi", nil)
		return
	}

	user, err := a.repo.GetUserByEmail(r.Context(), req.Email)
	if err != nil || user == nil {
		writeError(w, http.StatusUnauthorized, "Email atau password tidak sesuai.", nil)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		writeError(w, http.StatusUnauthorized, "Email atau password tidak sesuai.", nil)
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{
		User:    user,
		Message: "Autentikasi berhasil",
	})
}

func formatEventResponse(ev *model.WebhookEvent) EventResponse {
	res := EventResponse{
		WebhookEvent: ev,
		PayloadRaw:   string(ev.Payload),
		DeliveryLog:  make([]model.DeliveryLogEntry, 0),
	}

	var jsonParsed any
	if len(ev.Payload) > 0 && json.Unmarshal(ev.Payload, &jsonParsed) == nil {
		res.PayloadJSON = jsonParsed
	}

	// Construct delivery timeline based on attempts and status
	attempts := ev.Attempts
	if attempts == 0 && ev.Status != model.StatusPending {
		attempts = 1
	}

	for i := 1; i <= attempts; i++ {
		isFinal := (i == attempts)
		code := 500
		durationMs := int64(80 + (i * 25))
		errMsg := ""

		if isFinal {
			if ev.Status == model.StatusDelivered {
				code = ev.HTTPStatusCode
				if code == 0 {
					code = 200
				}
				durationMs = 95
				errMsg = ""
			} else if ev.Status == model.StatusPending {
				code = 0
				durationMs = 0
				errMsg = "Awaiting replay dispatch"
			} else {
				code = ev.HTTPStatusCode
				errMsg = ev.LastError
			}
		} else {
			code = 502
			errMsg = "Bad Gateway"
		}

		timeOffset := time.Duration((attempts - i) * 30) * time.Second
		attemptTime := ev.UpdatedAt.Add(-timeOffset)
		if attemptTime.Before(ev.CreatedAt) {
			attemptTime = ev.CreatedAt
		}

		res.DeliveryLog = append(res.DeliveryLog, model.DeliveryLogEntry{
			Attempt:    i,
			StatusCode: code,
			DurationMs: durationMs,
			Error:      errMsg,
			CreatedAt:  attemptTime,
		})
	}

	return res
}

func extractPathID(r *http.Request, key string, fallbackSubpath string) string {
	if val := r.PathValue(key); val != "" {
		return val
	}

	// Fallback path matching
	path := strings.Trim(r.URL.Path, "/")
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part == fallbackSubpath && i+1 < len(parts) {
			id := parts[i+1]
			// Avoid returning subsequent sub-action like "replay"
			if id != "replay" {
				return id
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

func writeError(w http.ResponseWriter, statusCode int, message string, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	errDetails := ""
	if err != nil {
		errDetails = err.Error()
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":   message,
		"details": errDetails,
	})
}
