package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/rootless-sec/relaygate/internal/mailer"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

// EventResponse wraps model.WebhookEvent with parsed payload and delivery logs
type EventResponse struct {
	*model.WebhookEvent
	PayloadJSON      any                      `json:"payload_json,omitempty"`
	PayloadRaw       string                   `json:"payload_raw"`
	DeliveryLog      []model.DeliveryLogEntry `json:"delivery_log"`
	ErrorCode        string                   `json:"error_code,omitempty"`
	ErrorClass       string                   `json:"error_class,omitempty"`
	FailureCode      string                   `json:"failure_code,omitempty"`
	VerificationKind string                   `json:"verification_kind"`
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
	EligibleCount    int            `json:"eligible_count"`
	ReplayedCount    int            `json:"replayed_count"`
	SkippedCount     int            `json:"skipped_count"`
	SkippedBreakdown map[string]int `json:"skipped_breakdown"`
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

// RegisterResponse represents response when user requests registration OTP
type RegisterResponse struct {
	Status  string `json:"status"` // "pending_verification"
	Message string `json:"message"`
	Email   string `json:"email"`
	DevCode string `json:"dev_code,omitempty"`
}

// VerifyCodeRequest represents payload to verify email OTP
type VerifyCodeRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

// ResendCodeRequest represents payload to request a new OTP code
type ResendCodeRequest struct {
	Email string `json:"email"`
}

// ResendCodeResponse represents response when a new OTP code is resent
type ResendCodeResponse struct {
	Message string `json:"message"`
	Email   string `json:"email"`
	DevCode string `json:"dev_code,omitempty"`
}

// LoginRequest represents request body for user authentication
type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// AuthResponse represents the authentication response payload
type AuthResponse struct {
	Token   string      `json:"token,omitempty"`
	User    *model.User `json:"user"`
	Message string      `json:"message,omitempty"`
}

// KeyedMutex provides per-key mutual exclusion without holding a global lock across multiple operations
type KeyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyLockEntry
}

type keyLockEntry struct {
	mu  sync.Mutex
	ref int
}

// NewKeyedMutex creates a new KeyedMutex
func NewKeyedMutex() *KeyedMutex {
	return &KeyedMutex{
		locks: make(map[string]*keyLockEntry),
	}
}

// TryLock attempts to acquire the lock for a given key without blocking.
// Returns an unlock function and true if acquired; nil and false if already locked.
func (km *KeyedMutex) TryLock(key string) (func(), bool) {
	km.mu.Lock()
	defer km.mu.Unlock()

	entry, ok := km.locks[key]
	if !ok {
		entry = &keyLockEntry{}
		km.locks[key] = entry
	}

	if !entry.mu.TryLock() {
		return nil, false
	}
	entry.ref++

	return func() {
		entry.mu.Unlock()
		km.mu.Lock()
		defer km.mu.Unlock()
		entry.ref--
		if entry.ref <= 0 {
			delete(km.locks, key)
		}
	}, true
}

// Lock acquires the lock for a given key, blocking until available.
func (km *KeyedMutex) Lock(key string) func() {
	km.mu.Lock()
	entry, ok := km.locks[key]
	if !ok {
		entry = &keyLockEntry{}
		km.locks[key] = entry
	}
	entry.ref++
	km.mu.Unlock()

	entry.mu.Lock()

	return func() {
		entry.mu.Unlock()
		km.mu.Lock()
		defer km.mu.Unlock()
		entry.ref--
		if entry.ref <= 0 {
			delete(km.locks, key)
		}
	}
}

// API handles control plane REST requests
type API struct {
	repo       storage.Repository
	pool       *worker.Pool
	hub        *Hub
	mailer     *mailer.Mailer
	eventLocks *KeyedMutex
}

// NewAPI initializes control plane API handlers
func NewAPI(repo storage.Repository, pool *worker.Pool, hub *Hub, mailerOpt ...*mailer.Mailer) *API {
	var m *mailer.Mailer
	if len(mailerOpt) > 0 && mailerOpt[0] != nil {
		m = mailerOpt[0]
	} else {
		m = mailer.NewMailerFromEnv()
	}
	return &API{
		repo:       repo,
		pool:       pool,
		hub:        hub,
		mailer:     m,
		eventLocks: NewKeyedMutex(),
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

	reveal := r.URL.Query().Get("reveal") == "true" || r.URL.Query().Get("reveal") == "1"
	if reveal {
		session := a.getSession(r)
		if session == nil {
			writeError(w, http.StatusUnauthorized, "Sesi tidak valid atau telah kedaluwarsa. Autentikasi admin diperlukan untuk membuka header sensitif.", nil)
			return
		}

		if session.Role != "admin" {
			writeError(w, http.StatusForbidden, "admin role required to reveal sensitive headers", nil)
			return
		}

		// Extract ONLY names of sensitive headers that exist in this event (NO VALUES!)
		var sensNames []string
		for k := range event.Headers {
			if isSensitiveHeader(k) {
				sensNames = append(sensNames, k)
			}
		}
		sort.Strings(sensNames)
		revealedNamesStr := strings.Join(sensNames, ",")

		ip := ResolveClientIP(r)

		// Persist security audit log entry to database
		audit := &model.AuditReveal{
			ID:                  uuid.NewString(),
			EventID:             event.ID,
			UserID:              session.UserID,
			UserEmail:           session.UserEmail,
			RevealedHeaderNames: revealedNamesStr,
			IPAddress:           ip,
			CreatedAt:           time.Now().UTC(),
		}
		if err := a.repo.SaveAuditReveal(r.Context(), audit); err != nil {
			log.Printf("[AUDIT ERROR] Failed to save audit reveal: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to record audit log for reveal request", err)
			return
		}
		log.Printf("[AUDIT] Sensitive headers revealed for event %s by %s from IP %s (headers: %s)", id, session.UserEmail, ip, revealedNamesStr)
	}

	writeJSON(w, http.StatusOK, formatEventResponseWithReveal(event, reveal))
}

// executeSingleReplay performs server-side validation and resets an event for replay.
// It acquires a per-event lock so concurrent replays on the same event are safely serialized/rejected.
func (a *API) executeSingleReplay(ctx context.Context, id string) (*model.WebhookEvent, bool, string, error) {
	if id == "" {
		return nil, false, "", fmt.Errorf("event id is required")
	}

	unlock, ok := a.eventLocks.TryLock(id)
	if !ok {
		return nil, false, "ALREADY_PENDING", fmt.Errorf("Event ini sedang dalam antrean pengiriman (status Menunggu). Silakan tunggu hingga proses selesai.")
	}
	defer unlock()

	event, err := a.repo.GetEventByID(ctx, id)
	if err != nil || event == nil {
		return nil, false, "", fmt.Errorf("event not found")
	}

	// Idempotency: Reject immediate duplicate replay if event is already queued or running
	if event.Status == model.StatusPending || event.Status == model.StatusRetrying {
		return nil, false, "ALREADY_PENDING", fmt.Errorf("Event ini sedang dalam antrean pengiriman (status Menunggu). Silakan tunggu hingga proses selesai.")
	}

	if !event.IsEligibleForReplay() {
		fCode := event.FailureCode
		if fCode == "" {
			_, inferred := model.InferFailureCode(event.LastError, event.HTTPStatusCode, event.Attempts, event.IsVerified)
			fCode = string(inferred)
		}
		if fCode == "" {
			fCode = "INELIGIBLE"
		}
		return nil, false, fCode, fmt.Errorf("event ini tidak dapat diverifikasi ulang karena data signature pada request yang tersimpan tidak valid atau tidak lengkap. Perbaiki konfigurasi agar event berikutnya lolos, atau minta provider mengirim ulang.")
	}

	wasVerificationInvalid := (event.IsVerified == verifier.VerificationInvalid || event.IsVerified < 0)
	if wasVerificationInvalid {
		if err := a.repo.UpdateEventVerification(ctx, id, 0); err != nil {
			return nil, false, "", fmt.Errorf("failed to reset event verification state: %w", err)
		}
		event.IsVerified = 0
	}

	// Update status in repository to PENDING while preserving last HTTP status code (resets attempts to 0)
	if err := a.repo.UpdateEventStatus(ctx, id, model.StatusPending, event.HTTPStatusCode, ""); err != nil {
		return nil, false, "", fmt.Errorf("failed to reset event status: %w", err)
	}

	event.Status = model.StatusPending
	event.Attempts = 0
	event.LastError = ""
	event.FailureCode = ""
	event.ErrorCode = ""
	event.ErrorClass = ""
	event.FailedAt = nil
	event.VerificationKind = string(verifier.ProviderVerificationKind(event.Provider))

	// Enqueue in worker pool
	if a.pool != nil {
		a.pool.Enqueue(id)
	}

	// Broadcast update to SSE subscribers
	if a.hub != nil {
		a.hub.Broadcast("event_updated", event)
	}

	return event, wasVerificationInvalid, "", nil
}

// ReplayEvent handles POST /api/v1/events/{id}/replay
func (a *API) ReplayEvent(w http.ResponseWriter, r *http.Request) {
	id := extractPathID(r, "id", "events")
	event, wasVerificationInvalid, skipCode, err := a.executeSingleReplay(r.Context(), id)
	if err != nil {
		if skipCode == "ALREADY_PENDING" || skipCode == "IN_FLIGHT" {
			writeError(w, http.StatusConflict, err.Error(), nil)
			return
		}
		if skipCode != "" {
			writeError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		if err.Error() == "event not found" {
			writeError(w, http.StatusNotFound, "event not found", err)
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error(), err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":          "replaying",
		"id":              event.ID,
		"re_verification": wasVerificationInvalid,
		"message":         "event queued for immediate re-delivery",
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

	eligibleCount := 0
	skippedCount := 0
	skippedBreakdown := make(map[string]int)

	for _, id := range targetIDs {
		if id == "" {
			continue
		}
		_, _, skipCode, err := a.executeSingleReplay(r.Context(), id)
		if err != nil {
			skippedCount++
			if skipCode == "" {
				skipCode = "INELIGIBLE"
			}
			skippedBreakdown[skipCode]++
			continue
		}
		eligibleCount++
	}

	writeJSON(w, http.StatusOK, BulkReplayResponse{
		EligibleCount:    eligibleCount,
		ReplayedCount:    eligibleCount,
		SkippedCount:     skippedCount,
		SkippedBreakdown: skippedBreakdown,
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

	// Check if email is already registered and active
	existing, err := a.repo.GetUserByEmail(r.Context(), req.Email)
	if err == nil && existing != nil {
		writeError(w, http.StatusConflict, "Email sudah terdaftar. Silakan gunakan email lain atau masuk.", nil)
		return
	}

	// Rate limiting: prevent spamming if a verification code was sent within 30 seconds
	if pending, err := a.repo.GetEmailVerification(r.Context(), req.Email); err == nil && pending != nil {
		cooldownDuration := 30 * time.Second
		elapsed := time.Since(pending.LastSentAt)
		if elapsed < cooldownDuration {
			remaining := int((cooldownDuration - elapsed).Seconds())
			if remaining <= 0 {
				remaining = 1
			}
			writeError(w, http.StatusTooManyRequests, fmt.Sprintf("Harap tunggu %d detik sebelum mendaftar ulang atau meminta kode baru.", remaining), nil)
			return
		}
	}

	// Generate secure 6-digit verification code
	code, err := mailer.GenerateOTP()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal membuat kode verifikasi", err)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal memproses password", err)
		return
	}

	now := time.Now().UTC()
	verif := &model.EmailVerification{
		Email:        req.Email,
		Name:         req.Name,
		PasswordHash: string(hash),
		Code:         code,
		Attempts:     0,
		MaxAttempts:  model.DefaultVerificationMaxAttempts,
		LastSentAt:   now,
		ExpiresAt:    now.Add(15 * time.Minute),
		CreatedAt:    now,
	}

	if err := a.repo.SaveEmailVerification(r.Context(), verif); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal menyimpan data verifikasi", err)
		return
	}

	// Dispatch verification email
	if err := a.mailer.SendVerificationCode(req.Email, req.Name, code); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal mengirimkan kode verifikasi: "+err.Error(), err)
		return
	}

	devCode := ""
	if a.mailer.IsDev() {
		devCode = code
	}

	writeJSON(w, http.StatusOK, RegisterResponse{
		Status:  "pending_verification",
		Message: "Kode verifikasi telah dikirimkan ke email Anda.",
		Email:   req.Email,
		DevCode: devCode,
	})
}

// VerifyCode handles POST /api/v1/auth/verify and /api/v1/auth/verify-code
func (a *API) VerifyCode(w http.ResponseWriter, r *http.Request) {
	var req VerifyCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload", err)
		return
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Code = strings.TrimSpace(req.Code)

	if req.Email == "" || req.Code == "" {
		writeError(w, http.StatusBadRequest, "Email dan kode verifikasi wajib diisi", nil)
		return
	}
	if len(req.Code) != 6 {
		writeError(w, http.StatusBadRequest, "Kode verifikasi harus berupa 6 digit angka", nil)
		return
	}

	verif, err := a.repo.GetEmailVerification(r.Context(), req.Email)
	if err != nil || verif == nil {
		writeError(w, http.StatusBadRequest, "Kode verifikasi tidak ditemukan atau pendaftaran telah kedaluwarsa. Silakan daftar ulang.", nil)
		return
	}

	// Expiration check (keep record intact so user can request a fresh code via Resend)
	if time.Now().UTC().After(verif.ExpiresAt) {
		writeError(w, http.StatusBadRequest, "Kode verifikasi telah kedaluwarsa. Silakan kirim ulang kode baru.", nil)
		return
	}

	// Max attempts check
	if verif.Attempts >= verif.MaxAttempts {
		writeError(w, http.StatusTooManyRequests, "Terlalu banyak percobaan gagal. Silakan kirim ulang kode verifikasi baru.", nil)
		return
	}

	// Constant-time code match check to prevent timing attacks
	if subtle.ConstantTimeCompare([]byte(verif.Code), []byte(req.Code)) != 1 {
		newAttempts, _ := a.repo.IncrementVerificationAttempts(r.Context(), verif.Email)
		remaining := verif.MaxAttempts - newAttempts
		if remaining <= 0 {
			writeError(w, http.StatusBadRequest, "Kode verifikasi salah. Batas percobaan habis. Silakan kirim ulang kode verifikasi.", nil)
			return
		}
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Kode verifikasi salah. Sisa percobaan: %d.", remaining), nil)
		return
	}

	// Check if already registered
	existing, err := a.repo.GetUserByEmail(r.Context(), verif.Email)
	if err == nil && existing != nil {
		_ = a.repo.DeleteEmailVerification(r.Context(), verif.Email)
		writeError(w, http.StatusConflict, "Email sudah terdaftar. Silakan masuk.", nil)
		return
	}

	user := &model.User{
		ID:           "usr_" + strings.ToLower(uuid.NewString()[:8]),
		Name:         verif.Name,
		Email:        verif.Email,
		Role:         "viewer",
		PasswordHash: verif.PasswordHash,
		CreatedAt:    time.Now().UTC(),
	}

	if err := a.repo.SaveUser(r.Context(), user); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal mengaktifkan akun pengguna", err)
		return
	}

	_ = a.repo.DeleteEmailVerification(r.Context(), verif.Email)

	tokenBytes := make([]byte, 32)
	_, _ = rand.Read(tokenBytes)
	sessionToken := "sess_" + hex.EncodeToString(tokenBytes)
	session := &model.Session{
		Token:     sessionToken,
		UserID:    user.ID,
		UserEmail: user.Email,
		Role:      user.Role,
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	_ = a.repo.SaveSession(r.Context(), session)

	isHTTPS := r.TLS != nil || (IsTrustedProxy(r.RemoteAddr) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"))
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS,
		SameSite: http.SameSiteStrictMode,
	})

	writeJSON(w, http.StatusCreated, AuthResponse{
		Token:   sessionToken,
		User:    user,
		Message: "Verifikasi berhasil. Akun Anda telah aktif.",
	})
}

// ResendCode handles POST /api/v1/auth/resend-code
func (a *API) ResendCode(w http.ResponseWriter, r *http.Request) {
	var req ResendCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload", err)
		return
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Email == "" {
		writeError(w, http.StatusBadRequest, "Alamat email wajib diisi", nil)
		return
	}

	verif, err := a.repo.GetEmailVerification(r.Context(), req.Email)
	if err != nil || verif == nil {
		writeError(w, http.StatusNotFound, "Sesi pendaftaran tidak ditemukan. Silakan lakukan pendaftaran baru.", nil)
		return
	}

	// Reject if initial registration session was created more than 24 hours ago
	if time.Since(verif.CreatedAt) > 24*time.Hour {
		_ = a.repo.DeleteEmailVerification(r.Context(), verif.Email)
		writeError(w, http.StatusNotFound, "Sesi pendaftaran telah kedaluwarsa. Silakan lakukan pendaftaran baru.", nil)
		return
	}

	// 30 seconds rate-limit cooldown
	cooldownDuration := 30 * time.Second
	elapsed := time.Since(verif.LastSentAt)
	if elapsed < cooldownDuration {
		remaining := int((cooldownDuration - elapsed).Seconds())
		if remaining <= 0 {
			remaining = 1
		}
		writeError(w, http.StatusTooManyRequests, fmt.Sprintf("Harap tunggu %d detik sebelum meminta kode baru.", remaining), nil)
		return
	}

	newCode, err := mailer.GenerateOTP()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal membuat kode verifikasi baru", err)
		return
	}

	now := time.Now().UTC()
	verif.Code = newCode
	verif.Attempts = 0
	verif.LastSentAt = now
	verif.ExpiresAt = now.Add(15 * time.Minute)

	if err := a.repo.SaveEmailVerification(r.Context(), verif); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal memperbarui kode verifikasi", err)
		return
	}

	if err := a.mailer.SendVerificationCode(verif.Email, verif.Name, newCode); err != nil {
		writeError(w, http.StatusInternalServerError, "Gagal mengirimkan kode verifikasi baru: "+err.Error(), err)
		return
	}

	devCode := ""
	if a.mailer.IsDev() {
		devCode = newCode
	}

	writeJSON(w, http.StatusOK, ResendCodeResponse{
		Message: "Kode verifikasi baru telah dikirimkan ke email Anda.",
		Email:   verif.Email,
		DevCode: devCode,
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

	tokenBytes := make([]byte, 32)
	_, _ = rand.Read(tokenBytes)
	sessionToken := "sess_" + hex.EncodeToString(tokenBytes)
	role := user.Role
	if role == "" {
		role = "viewer"
	}
	now := Now()
	absTimeout, _ := GetSessionTimeouts()
	session := &model.Session{
		Token:        sessionToken,
		UserID:       user.ID,
		UserEmail:    user.Email,
		Role:         role,
		ExpiresAt:    now.Add(absTimeout),
		LastActiveAt: now,
		CreatedAt:    now,
	}
	_ = a.repo.SaveSession(r.Context(), session)

	isHTTPS := r.TLS != nil || (IsTrustedProxy(r.RemoteAddr) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"))

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS,
		SameSite: http.SameSiteStrictMode,
	})

	writeJSON(w, http.StatusOK, AuthResponse{
		Token:   sessionToken,
		User:    user,
		Message: "Autentikasi berhasil",
	})
}

// Logout terminates active session and clears session cookie
func (a *API) Logout(w http.ResponseWriter, r *http.Request) {
	token := extractTokenFromRequest(r)
	if token != "" && a.repo != nil {
		_ = a.repo.DeleteSession(r.Context(), token)
	}

	isHTTPS := r.TLS != nil || (IsTrustedProxy(r.RemoteAddr) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"))

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   isHTTPS,
		SameSite: http.SameSiteStrictMode,
	})

	writeJSON(w, http.StatusOK, map[string]string{
		"message": "Sesi telah berakhir",
	})
}

func (a *API) getSession(r *http.Request) *model.Session {
	if s, ok := r.Context().Value(SessionContextKey).(*model.Session); ok && s != nil {
		return s
	}
	token := extractTokenFromRequest(r)
	if token != "" && a.repo != nil {
		if s, err := a.repo.GetSession(r.Context(), token); err == nil && s != nil {
			now := Now()
			isAbsExpired := now.After(s.ExpiresAt)
			isIdleExpired := false
			if !s.LastActiveAt.IsZero() {
				isIdleExpired = now.Sub(s.LastActiveAt) > GetSessionIdleTimeout()
			} else if !s.CreatedAt.IsZero() {
				isIdleExpired = now.Sub(s.CreatedAt) > GetSessionIdleTimeout()
			}
			if !isAbsExpired && !isIdleExpired {
				return s
			}
		}
	}
	return nil
}

func isSensitiveHeader(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	if lower == "authorization" ||
		lower == "proxy-authorization" ||
		lower == "cookie" ||
		lower == "set-cookie" ||
		lower == "x-callback-token" ||
		lower == "x-api-key" ||
		lower == "stripe-signature" ||
		strings.HasPrefix(lower, "x-hub-signature") {
		return true
	}
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "signature") ||
		strings.Contains(lower, "auth") ||
		strings.Contains(lower, "password") ||
		strings.Contains(lower, "key") ||
		strings.Contains(lower, "cookie")
}

func maskHeaders(headers map[string]string) map[string]string {
	if headers == nil {
		return nil
	}
	masked := make(map[string]string, len(headers))
	for k, v := range headers {
		if isSensitiveHeader(k) {
			masked[k] = "••••••••••••••••••••••••••••••••"
		} else {
			masked[k] = v
		}
	}
	return masked
}

func formatEventResponse(ev *model.WebhookEvent) EventResponse {
	return formatEventResponseWithReveal(ev, false)
}

func formatEventResponseWithReveal(ev *model.WebhookEvent, revealSensitive bool) EventResponse {
	class, code := model.ClassifyEventError(ev)
	ev.ErrorClass = class
	ev.ErrorCode = code
	if ev.FailureCode == "" {
		ev.FailureCode = code
	}
	if ev.FailedAt == nil && ev.Status == model.StatusFailed {
		if !ev.UpdatedAt.IsZero() {
			ev.FailedAt = &ev.UpdatedAt
		} else {
			ev.FailedAt = &ev.CreatedAt
		}
	}
	vKind := string(verifier.ProviderVerificationKind(ev.Provider))
	ev.VerificationKind = vKind

	evCopy := *ev
	evCopy.VerificationKind = vKind
	if !revealSensitive && evCopy.Headers != nil {
		evCopy.Headers = maskHeaders(ev.Headers)
	}

	res := EventResponse{
		WebhookEvent:     &evCopy,
		PayloadRaw:       string(ev.Payload),
		DeliveryLog:      make([]model.DeliveryLogEntry, 0),
		ErrorCode:        code,
		FailureCode:      ev.FailureCode,
		ErrorClass:       class,
		VerificationKind: vKind,
	}

	var jsonParsed any
	if len(ev.Payload) > 0 && json.Unmarshal(ev.Payload, &jsonParsed) == nil {
		res.PayloadJSON = jsonParsed
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
