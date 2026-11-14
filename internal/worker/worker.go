package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rootless-sec/relaygate/internal/agent"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/notifier"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
)

var hopByHopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailers":            true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"host":                true,
	"content-length":      true,
}

// Config defines worker pool runtime parameters
type Config struct {
	Concurrency    int
	BaseBackoff    time.Duration
	MaxBackoff     time.Duration
	JitterFraction float64
	PollInterval   time.Duration
	HTTPTimeout    time.Duration
	HTTPClient     *http.Client
}

// DefaultConfig returns default production settings
func DefaultConfig() Config {
	return Config{
		Concurrency:    10,
		BaseBackoff:    10 * time.Second,
		MaxBackoff:     1 * time.Hour,
		JitterFraction: 0.2, // +/- 20%
		PollInterval:   3 * time.Second,
		HTTPTimeout:    15 * time.Second,
	}
}

// ApplyEnvOverrides applies optional environment variable overrides to Config.
// If an environment variable is empty or invalid, the existing default is preserved.
func (c *Config) ApplyEnvOverrides() {
	if s := os.Getenv("RELAYGATE_WORKER_BASE_BACKOFF"); s != "" {
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			c.BaseBackoff = d
		}
	}
	if s := os.Getenv("RELAYGATE_WORKER_POLL_INTERVAL"); s != "" {
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			c.PollInterval = d
		}
	}
	if s := os.Getenv("RELAYGATE_WORKER_HTTP_TIMEOUT"); s != "" {
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			c.HTTPTimeout = d
		}
	}
}

type circuitState int

const (
	circuitClosed circuitState = iota
	circuitOpen
	circuitHalfOpen
)

type circuitBreakerEntry struct {
	state               circuitState
	consecutiveFailures int
	openUntil           time.Time
	probeInFlight       bool
}

// ParseRetryAfter parses an HTTP Retry-After header value (delta-seconds or HTTP-date).
// Zero or negative delta-seconds are clamped to a minimum 2-second backoff.
// Past HTTP-dates or malformed values return (zero, false) so callers fall back to exponential backoff.
func ParseRetryAfter(headerVal string, now time.Time) (time.Time, bool) {
	headerVal = strings.TrimSpace(headerVal)
	if headerVal == "" {
		return time.Time{}, false
	}

	if secs, err := strconv.ParseInt(headerVal, 10, 64); err == nil {
		if secs <= 0 {
			secs = 2
		}
		if secs > 86400 {
			secs = 86400
		}
		return now.UTC().Add(time.Duration(secs) * time.Second), true
	}

	if parsedTime, err := http.ParseTime(headerVal); err == nil {
		if parsedTime.After(now) {
			return parsedTime.UTC(), true
		}
		return time.Time{}, false
	}

	return time.Time{}, false
}

// Pool manages concurrent dispatch workers and retry scheduling
type Pool struct {
	repo     storage.Repository
	verifier *verifier.Engine
	notifier *notifier.Manager
	config   Config
	queue    chan string
	client   *http.Client
	rnd      *rand.Rand
	rndMu    sync.Mutex
	inFlight sync.Map

	cbMu     sync.Mutex
	circuits map[string]*circuitBreakerEntry

	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	running     atomic.Bool
	broadcaster model.Broadcaster
	agentHub    *agent.Hub
}

// NewPool initializes a new worker pool
func NewPool(repo storage.Repository, v *verifier.Engine, cfg Config) *Pool {
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 10
	}
	if cfg.BaseBackoff <= 0 {
		cfg.BaseBackoff = 10 * time.Second
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 1 * time.Hour
	}
	if cfg.JitterFraction <= 0 {
		cfg.JitterFraction = 0.2
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 3 * time.Second
	}
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 15 * time.Second
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: cfg.HTTPTimeout,
		}
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &Pool{
		repo:     repo,
		verifier: v,
		notifier: notifier.NewManager(notifier.DefaultCooldownWindow),
		config:   cfg,
		queue:    make(chan string, 1000),
		client:   client,
		rnd:      rand.New(rand.NewSource(time.Now().UnixNano())),
		circuits: make(map[string]*circuitBreakerEntry),
		ctx:      ctx,
		cancel:   cancel,
	}
}

func (p *Pool) circuitOpenDuration() time.Duration {
	if p.config.PollInterval > 0 && p.config.PollInterval <= 200*time.Millisecond {
		return 1200 * time.Millisecond
	}
	return 60 * time.Second
}

func (p *Pool) checkCircuitAllow(cbKey string) (bool, time.Time) {
	p.cbMu.Lock()
	defer p.cbMu.Unlock()

	entry, ok := p.circuits[cbKey]
	if !ok || entry.state == circuitClosed {
		return true, time.Time{}
	}

	now := time.Now().UTC()
	if entry.state == circuitOpen {
		if now.Before(entry.openUntil) {
			return false, entry.openUntil
		}
		entry.state = circuitHalfOpen
		entry.probeInFlight = true
		return true, time.Time{}
	}

	// circuitHalfOpen: allow only one probe at a time
	if entry.probeInFlight {
		return false, now.Add(p.circuitOpenDuration())
	}
	entry.probeInFlight = true
	return true, time.Time{}
}

func (p *Pool) recordCircuitSuccess(cbKey string) {
	p.cbMu.Lock()
	defer p.cbMu.Unlock()

	if entry, ok := p.circuits[cbKey]; ok {
		entry.state = circuitClosed
		entry.consecutiveFailures = 0
		entry.probeInFlight = false
		entry.openUntil = time.Time{}
	}
}

// ResetCircuit resets any open circuit breaker state for the given endpoint ID (e.g. on manual operator replay).
func (p *Pool) ResetCircuit(endpointID string) {
	if p == nil {
		return
	}
	p.cbMu.Lock()
	defer p.cbMu.Unlock()

	prefix := endpointID + "|"
	for k := range p.circuits {
		if k == endpointID || strings.HasPrefix(k, prefix) {
			delete(p.circuits, k)
		}
	}
}

func (p *Pool) recordCircuitFailure(cbKey string) bool {
	p.cbMu.Lock()
	defer p.cbMu.Unlock()

	entry, ok := p.circuits[cbKey]
	if !ok {
		entry = &circuitBreakerEntry{state: circuitClosed}
		p.circuits[cbKey] = entry
	}

	entry.consecutiveFailures++
	entry.probeInFlight = false
	if entry.consecutiveFailures >= 5 || entry.state == circuitHalfOpen {
		tripped := entry.state != circuitOpen
		entry.state = circuitOpen
		entry.openUntil = time.Now().UTC().Add(p.circuitOpenDuration())
		return tripped
	}
	return false
}

// Start launches worker pool routines and background retry scheduler
func (p *Pool) Start() {
	if !p.running.CompareAndSwap(false, true) {
		return
	}

	// Spawn worker goroutines
	for i := 0; i < p.config.Concurrency; i++ {
		p.wg.Add(1)
		go p.workerLoop(i)
	}

	// Spawn retry scheduler routine
	p.wg.Add(1)
	go p.retrySchedulerLoop()
}

// Stop gracefully stops workers and waits for in-flight requests to complete
func (p *Pool) Stop() {
	if !p.running.CompareAndSwap(true, false) {
		return
	}

	p.cancel()
	p.wg.Wait()
}

// SetBroadcaster configures a real-time event broadcaster for dispatch updates
func (p *Pool) SetBroadcaster(b model.Broadcaster) {
	p.broadcaster = b
}

// SetAgentHub configures an outbound agent tunnel hub for NAT-traversal dispatch.
func (p *Pool) SetAgentHub(h *agent.Hub) {
	p.agentHub = h
}

func (p *Pool) notifyUpdate(event *model.WebhookEvent) {
	if p.broadcaster != nil && event != nil {
		p.broadcaster.Broadcast("event_updated", event)
	}
}

// Enqueue adds an event ID to the dispatch queue
func (p *Pool) Enqueue(eventID string) bool {
	if !p.running.Load() {
		return false
	}

	select {
	case p.queue <- eventID:
		return true
	case <-p.ctx.Done():
		return false
	default:
		// Queue full: do not block or leak unmanaged goroutines.
		// The event is already durable in SQLite WAL as PENDING.
		// The retrySchedulerLoop will safely pick it up from the database.
		return true
	}
}

func (p *Pool) workerLoop(workerID int) {
	defer p.wg.Done()

	for {
		select {
		case <-p.ctx.Done():
			return
		case eventID := <-p.queue:
			p.processEvent(eventID)
		}
	}
}

func (p *Pool) retrySchedulerLoop() {
	defer p.wg.Done()

	ticker := time.NewTicker(p.config.PollInterval)
	defer ticker.Stop()

	lastCheckpoint := time.Now()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			doCheckpoint := time.Since(lastCheckpoint) >= 30*time.Second
			if doCheckpoint {
				lastCheckpoint = time.Now()
			}
			p.scheduleRetries(doCheckpoint)
		}
	}
}

func (p *Pool) scheduleRetries(doCheckpoint bool) {
	ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	defer cancel()

	// Periodic WAL checkpoint maintenance
	if doCheckpoint {
		_ = p.repo.Checkpoint(ctx)
	}

	// 1. Fetch pending retries
	retries, err := p.repo.GetPendingRetries(ctx, 100)
	if err == nil {
		for _, ev := range retries {
			if _, inFlight := p.inFlight.Load(ev.ID); !inFlight {
				p.Enqueue(ev.ID)
			}
		}
	}

	// 2. Fetch un-dispatched pending events (e.g. from crash or restart)
	pending, err := p.repo.GetPendingEvents(ctx, 100)
	if err == nil {
		for _, ev := range pending {
			if _, inFlight := p.inFlight.Load(ev.ID); !inFlight {
				p.Enqueue(ev.ID)
			}
		}
	}
}

// IsInFlight checks whether an event is currently being processed in worker goroutines
func (p *Pool) IsInFlight(eventID string) bool {
	if p == nil {
		return false
	}
	_, ok := p.inFlight.Load(eventID)
	return ok
}

// Dispatch executes the HTTP delivery of a single webhook event
func (p *Pool) Dispatch(ctx context.Context, eventID string) error {
	return p.processEventWithContext(ctx, eventID)
}

func (p *Pool) processEvent(eventID string) {
	ctx, cancel := context.WithTimeout(p.ctx, p.config.HTTPTimeout+5*time.Second)
	defer cancel()

	_ = p.processEventWithContext(ctx, eventID)
}

func (p *Pool) processEventWithContext(ctx context.Context, eventID string) error {
	if _, loaded := p.inFlight.LoadOrStore(eventID, time.Now()); loaded {
		return nil
	}
	defer p.inFlight.Delete(eventID)

	event, err := p.repo.GetEventByID(ctx, eventID)
	if err != nil {
		return fmt.Errorf("failed to load event %s: %w", eventID, err)
	}

	// Only process if status is PENDING or RETRYING
	if event.Status != model.StatusPending && event.Status != model.StatusRetrying {
		return nil
	}

	event.MaxAttempts = model.NormalizeMaxAttempts(event.MaxAttempts)

	// An event that has already exhausted attempts must be marked FAILED rather than silently dropped
	if event.Attempts >= event.MaxAttempts {
		now := time.Now().UTC()
		failureCode := event.FailureCode
		if failureCode == "" {
			if event.HTTPStatusCode >= 500 {
				failureCode = string(model.ErrCodeHTTP5xx)
			} else if event.HTTPStatusCode >= 400 {
				failureCode = string(model.ErrCodeHTTP4xx)
			} else {
				failureCode = string(model.ErrCodeDeliveryFailed)
			}
		}
		_ = p.repo.UpdateEventFailure(ctx, event.ID, model.StatusFailed, event.HTTPStatusCode, event.LastError, failureCode, &now)
		event.Status = model.StatusFailed
		event.FailedAt = &now
		if ep, epErr := p.repo.GetEndpointByID(ctx, event.EndpointID); epErr == nil && ep != nil && p.notifier != nil && notifier.HasChannels(ep) {
			p.notifier.NotifyIncident(ctx, ep, event.ID, "event entered DLQ after exhausting max retries: "+event.LastError)
		}
		p.notifyUpdate(event)
		return nil
	}

	endpoint, err := p.repo.GetEndpointByID(ctx, event.EndpointID)
	if err != nil {
		errMsg := fmt.Sprintf("endpoint %s not found: %v", event.EndpointID, err)
		now := time.Now().UTC()
		_ = p.repo.UpdateEventFailure(ctx, event.ID, model.StatusFailed, 0, errMsg, string(model.ErrCodeDeliveryFailed), &now)
		event.Status = model.StatusFailed
		event.LastError = errMsg
		event.FailureCode = string(model.ErrCodeDeliveryFailed)
		event.ErrorCode = string(model.ErrCodeDeliveryFailed)
		event.FailedAt = &now
		event.ErrorClass = string(model.ErrorClassDeliveryFailed)
		p.notifyUpdate(event)
		return fmt.Errorf("%s", errMsg)
	}

	if !endpoint.IsActive {
		errMsg := fmt.Sprintf("endpoint %s is disabled", endpoint.ID)
		now := time.Now().UTC()
		_ = p.repo.UpdateEventFailure(ctx, event.ID, model.StatusFailed, 0, errMsg, string(model.ErrCodeDeliveryFailed), &now)
		event.Status = model.StatusFailed
		event.LastError = errMsg
		event.FailureCode = string(model.ErrCodeDeliveryFailed)
		event.ErrorCode = string(model.ErrCodeDeliveryFailed)
		event.FailedAt = &now
		event.ErrorClass = string(model.ErrorClassDeliveryFailed)
		p.notifyUpdate(event)
		return fmt.Errorf("%s", errMsg)
	}

	// Cryptographic verification check
	skipGenericOutboundOnly := endpoint.Provider == model.ProviderGeneric && endpoint.WrapEnvelope && strings.TrimSpace(event.Signature) == ""
	if p.verifier != nil && endpoint.SecretKey != "" && !skipGenericOutboundOnly {
		if event.IsVerified == 0 {
			verificationStatus, vErr := p.verifier.Verify(endpoint, event.Headers, event.Payload)
			_ = p.repo.UpdateEventVerification(ctx, event.ID, verificationStatus)
			event.IsVerified = verificationStatus
			if verificationStatus == verifier.VerificationInvalid {
				var failureCode model.ErrorCode = model.ErrCodeSignatureMismatch
				var vTypedErr *verifier.VerificationError
				if errors.As(vErr, &vTypedErr) {
					failureCode = vTypedErr.Code
				}

				errMsg := "cryptographic signature verification failed"
				if endpoint.Provider == model.ProviderXendit {
					errMsg = "callback token verification failed"
					if vErr != nil {
						errMsg = fmt.Sprintf("callback token verification failed: %v", vErr)
					}
				} else if vErr != nil {
					errMsg = fmt.Sprintf("cryptographic signature verification failed: %v", vErr)
				}
				now := time.Now().UTC()
				_ = p.repo.UpdateEventFailure(ctx, event.ID, model.StatusFailed, 0, errMsg, string(failureCode), &now)
				event.Status = model.StatusFailed
				event.LastError = errMsg
				event.FailureCode = string(failureCode)
				event.ErrorCode = string(failureCode)
				event.FailedAt = &now
				event.ErrorClass = string(model.ErrorClassVerificationRejected)
				if p.notifier != nil && notifier.HasChannels(endpoint) {
					p.notifier.NotifyIncident(ctx, endpoint, event.ID, "event entered DLQ due to verification failure: "+errMsg)
				}
				p.notifyUpdate(event)
				return fmt.Errorf("%s", errMsg)
			}
		} else if event.IsVerified == verifier.VerificationInvalid {
			errMsg := event.LastError
			if errMsg == "" {
				if endpoint.Provider == model.ProviderXendit {
					errMsg = "callback token verification failed"
				} else {
					errMsg = "cryptographic signature verification failed"
				}
			}
			var failureCode model.ErrorCode = model.ErrCodeSignatureMismatch
			if event.FailureCode != "" {
				failureCode = model.ErrorCode(event.FailureCode)
			} else {
				_, inferredCode := model.InferFailureCode(errMsg, 0, 0, -1)
				failureCode = inferredCode
			}
			now := time.Now().UTC()
			_ = p.repo.UpdateEventFailure(ctx, event.ID, model.StatusFailed, 0, errMsg, string(failureCode), &now)
			event.Status = model.StatusFailed
			event.LastError = errMsg
			event.FailureCode = string(failureCode)
			event.ErrorCode = string(failureCode)
			event.FailedAt = &now
			event.ErrorClass = string(model.ErrorClassVerificationRejected)
			p.notifyUpdate(event)
			return fmt.Errorf("%s", errMsg)
		}
	}

	// Resolve target URL (fan-out destination override or endpoint default)
	targetURL := strings.TrimSpace(event.TargetURL)
	if targetURL == "" {
		targetURL = strings.TrimSpace(endpoint.TargetURL)
	}
	cbKey := endpoint.ID + "|" + targetURL

	// Pre-flight Circuit Breaker check
	if allowed, openUntil := p.checkCircuitAllow(cbKey); !allowed {
		errMsg := "circuit breaker open: deferring delivery without penalty"
		_ = p.repo.DeferRetry(ctx, event.ID, openUntil, errMsg, event.HTTPStatusCode)
		event.Status = model.StatusRetrying
		event.NextRetryAt = &openUntil
		event.LastError = errMsg
		p.notifyUpdate(event)
		return nil
	}

	// Prepare downstream HTTP request body and canonicalized outbound headers
	bodyToSend := event.Payload
	var canonicalEnv *model.CanonicalEnvelope
	if endpoint.WrapEnvelope {
		env := model.BuildCanonicalEnvelope(endpoint.Provider, event.Headers, event.Payload, event.ID)
		if envBytes, mErr := json.Marshal(env); mErr == nil {
			bodyToSend = envBytes
			canonicalEnv = &env
		}
	}

	outboundHeaders := make(map[string]string, len(event.Headers)+8)
	for k, v := range event.Headers {
		lowerK := strings.ToLower(k)
		if !hopByHopHeaders[lowerK] && lowerK != "x-relaygate-request-target" {
			outboundHeaders[http.CanonicalHeaderKey(k)] = v
		}
	}

	// Add RelayGate observability headers
	outboundHeaders["X-Relaygate-Delivery"] = event.ID
	outboundHeaders["X-Relaygate-Attempt"] = strconv.Itoa(event.Attempts + 1)
	outboundHeaders["X-Relaygate-Provider"] = string(event.Provider)
	outboundHeaders["X-Relaygate-Verified"] = strconv.Itoa(event.IsVerified)

	if canonicalEnv != nil {
		outboundHeaders["Content-Type"] = "application/json"
		outboundHeaders["X-Relaygate-Event-Type"] = canonicalEnv.EventType
		outboundHeaders["X-Relaygate-External-Id"] = canonicalEnv.ExternalID

		msgID := "msg_" + event.ID
		tsStr, stdSig := model.SignStandardWebhook(msgID, time.Now().UTC(), bodyToSend, endpoint.SecretKey)
		outboundHeaders["Webhook-Id"] = msgID
		outboundHeaders["Webhook-Timestamp"] = tsStr
		outboundHeaders["Webhook-Signature"] = stdSig
	}

	var (
		statusCode       int
		retryAfterHeader string
		bodySnippet      string
		durationMs       int64
		deliveryErr      error
	)

	startDelivery := time.Now()
	if p.agentHub != nil && p.agentHub.HasAgent(endpoint.ID) {
		agentResp, dErr := p.agentHub.Dispatch(ctx, endpoint.ID, agent.DispatchRequest{
			EventID:       event.ID,
			EndpointID:    endpoint.ID,
			TargetURL:     targetURL,
			Method:        http.MethodPost,
			Headers:       outboundHeaders,
			PayloadBase64: base64.StdEncoding.EncodeToString(bodyToSend),
			TimeoutMs:     p.config.HTTPTimeout.Milliseconds(),
		})
		durationMs = time.Since(startDelivery).Milliseconds()
		if dErr != nil {
			deliveryErr = dErr
		} else if agentResp.Error != "" {
			if agentResp.DurationMs > 0 {
				durationMs = agentResp.DurationMs
			}
			deliveryErr = errors.New(agentResp.Error)
		} else {
			statusCode = agentResp.StatusCode
			retryAfterHeader = agentResp.RetryAfter
			bodySnippet = agentResp.BodySnippet
			if agentResp.DurationMs > 0 {
				durationMs = agentResp.DurationMs
			}
		}
	} else {
		req, rErr := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyToSend))
		if rErr != nil {
			errMsg := fmt.Sprintf("failed to construct request: %v", rErr)
			return p.handleFailure(ctx, endpoint, event, 0, errMsg)
		}
		for k, v := range outboundHeaders {
			req.Header.Set(k, v)
		}

		resp, rErr := p.client.Do(req)
		durationMs = time.Since(startDelivery).Milliseconds()
		if rErr != nil {
			deliveryErr = rErr
		} else {
			defer resp.Body.Close()
			rawSnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
			statusCode = resp.StatusCode
			retryAfterHeader = resp.Header.Get("Retry-After")
			bodySnippet = strings.TrimSpace(string(rawSnippet))
		}
	}

	if deliveryErr != nil {
		errMsg := fmt.Sprintf("network delivery error: %v", deliveryErr)
		_ = p.repo.SaveDeliveryLog(ctx, event.ID, &model.DeliveryLogEntry{
			Attempt:    event.Attempts + 1,
			StatusCode: 0,
			DurationMs: durationMs,
			Error:      errMsg,
			CreatedAt:  time.Now().UTC(),
		})
		if p.recordCircuitFailure(cbKey) && p.notifier != nil {
			p.notifier.NotifyIncident(ctx, endpoint, event.ID, "circuit breaker tripped after 5 consecutive failures: "+errMsg)
		}
		return p.handleFailure(ctx, endpoint, event, 0, errMsg)
	}

	// Success response: 2xx
	if statusCode >= 200 && statusCode < 300 {
		p.recordCircuitSuccess(cbKey)
		err := p.repo.UpdateEventStatus(ctx, event.ID, model.StatusDelivered, statusCode, "")
		_ = p.repo.SaveDeliveryLog(ctx, event.ID, &model.DeliveryLogEntry{
			Attempt:    event.Attempts + 1,
			StatusCode: statusCode,
			DurationMs: durationMs,
			Error:      "",
			CreatedAt:  time.Now().UTC(),
		})
		if err == nil {
			event.Status = model.StatusDelivered
			event.HTTPStatusCode = statusCode
			event.Attempts++
			event.LastError = ""
			event.FailureCode = ""
			event.ErrorCode = ""
			p.notifyUpdate(event)
		}
		return err
	}

	// Failure response: 4xx, 5xx
	errMsg := fmt.Sprintf("downstream returned HTTP %d: %s", statusCode, bodySnippet)
	_ = p.repo.SaveDeliveryLog(ctx, event.ID, &model.DeliveryLogEntry{
		Attempt:    event.Attempts + 1,
		StatusCode: statusCode,
		DurationMs: durationMs,
		Error:      errMsg,
		CreatedAt:  time.Now().UTC(),
	})

	// Check for HTTP 429 / 503 Retry-After non-penalizing deferral
	if statusCode == http.StatusTooManyRequests || statusCode == http.StatusServiceUnavailable {
		if strings.TrimSpace(retryAfterHeader) != "" {
			if nextRetryAt, ok := ParseRetryAfter(retryAfterHeader, time.Now().UTC()); ok {
				dErr := p.repo.DeferRetry(ctx, event.ID, nextRetryAt, errMsg, statusCode)
				if dErr == nil {
					event.Status = model.StatusRetrying
					event.HTTPStatusCode = statusCode
					event.LastError = errMsg
					event.NextRetryAt = &nextRetryAt
					p.notifyUpdate(event)
				}
				if statusCode == http.StatusServiceUnavailable && p.notifier != nil {
					p.notifier.NotifyIncident(ctx, endpoint, event.ID, "downstream maintenance / consecutive failure (circuit monitor): "+errMsg)
				}
				return dErr
			}
		}
	}

	if statusCode >= 500 {
		if p.recordCircuitFailure(cbKey) && p.notifier != nil {
			p.notifier.NotifyIncident(ctx, endpoint, event.ID, "circuit breaker tripped after consecutive failures: "+errMsg)
		}
	}

	return p.handleFailure(ctx, endpoint, event, statusCode, errMsg)
}

func (p *Pool) handleFailure(ctx context.Context, endpoint *model.Endpoint, event *model.WebhookEvent, statusCode int, errMsg string) error {
	event.MaxAttempts = model.NormalizeMaxAttempts(event.MaxAttempts)
	nextAttempt := event.Attempts + 1
	if nextAttempt > event.MaxAttempts {
		nextAttempt = event.MaxAttempts
	}
	var err error
	if nextAttempt >= event.MaxAttempts {
		// Dead-letter queue transition
		err = p.repo.IncrementAttempts(ctx, event.ID, nil, errMsg, statusCode)
		if err == nil {
			now := time.Now().UTC()
			event.Status = model.StatusFailed
			event.Attempts = nextAttempt
			event.HTTPStatusCode = statusCode
			event.LastError = errMsg
			event.NextRetryAt = nil
			event.FailedAt = &now
			_, code := model.InferFailureCode(errMsg, statusCode, nextAttempt, 1)
			event.FailureCode = string(code)
			event.ErrorCode = string(code)
			event.ErrorClass = string(model.ErrorClassDeliveryFailed)
			p.notifyUpdate(event)
		}
		if p.notifier != nil {
			p.notifier.NotifyIncident(ctx, endpoint, event.ID, "event entered dead-letter queue (circuit / consecutive failure monitor): "+errMsg)
		}
		return err
	}

	// Calculate exponential backoff with jitter
	backoff := p.CalculateBackoff(event.Attempts)
	nextRetryAt := time.Now().UTC().Add(backoff)

	err = p.repo.IncrementAttempts(ctx, event.ID, &nextRetryAt, errMsg, statusCode)
	if err == nil {
		event.Status = model.StatusRetrying
		event.Attempts = nextAttempt
		event.HTTPStatusCode = statusCode
		event.LastError = errMsg
		event.NextRetryAt = &nextRetryAt
		p.notifyUpdate(event)
	}
	if statusCode >= 500 && p.notifier != nil {
		p.notifier.NotifyIncident(ctx, endpoint, event.ID, "downstream failure (circuit / consecutive failure monitor): "+errMsg)
	}
	return err
}

// CalculateBackoff computes: base * 2^attempt +/- jitter
func (p *Pool) CalculateBackoff(attempt int) time.Duration {
	base := p.config.BaseBackoff
	maxBackoff := p.config.MaxBackoff
	jitterFraction := p.config.JitterFraction

	if attempt < 0 {
		attempt = 0
	}
	// Avoid overflow
	if attempt > 30 {
		attempt = 30
	}

	multiplier := int64(1) << attempt
	backoffSec := float64(base.Seconds()) * float64(multiplier)

	if backoffSec > maxBackoff.Seconds() {
		backoffSec = maxBackoff.Seconds()
	}

	p.rndMu.Lock()
	// random jitter in range [-jitterFraction, +jitterFraction]
	randomFraction := (p.rnd.Float64()*2 - 1) * jitterFraction
	p.rndMu.Unlock()

	jitteredSec := backoffSec * (1 + randomFraction)
	// Lower bound of 1 second
	if jitteredSec < 1.0 {
		jitteredSec = 1.0
	}
	if jitteredSec > maxBackoff.Seconds() {
		jitteredSec = maxBackoff.Seconds()
	}

	return time.Duration(jitteredSec * float64(time.Second))
}
