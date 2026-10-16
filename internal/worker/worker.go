package worker

import (
	"bytes"
	"context"
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

	"github.com/rootless-sec/relaygate/internal/model"
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

// Pool manages concurrent dispatch workers and retry scheduling
type Pool struct {
	repo     storage.Repository
	verifier *verifier.Engine
	config   Config
	queue    chan string
	client   *http.Client
	rnd      *rand.Rand
	rndMu    sync.Mutex
	inFlight sync.Map

	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	running     atomic.Bool
	broadcaster model.Broadcaster
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
		config:   cfg,
		queue:    make(chan string, 1000),
		client:   client,
		rnd:      rand.New(rand.NewSource(time.Now().UnixNano())),
		ctx:      ctx,
		cancel:   cancel,
	}
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

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.scheduleRetries()
		}
	}
}

func (p *Pool) scheduleRetries() {
	ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	defer cancel()

	// Periodic WAL checkpoint maintenance
	_ = p.repo.Checkpoint(ctx)

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
	if p.verifier != nil && endpoint.SecretKey != "" {
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

	// Prepare downstream HTTP request
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.TargetURL, bytes.NewReader(event.Payload))
	if err != nil {
		errMsg := fmt.Sprintf("failed to construct request: %v", err)
		return p.handleFailure(ctx, event, 0, errMsg)
	}

	// Forward original headers (filtering hop-by-hop headers)
	for k, v := range event.Headers {
		lowerK := strings.ToLower(k)
		if !hopByHopHeaders[lowerK] {
			req.Header.Set(k, v)
		}
	}

	// Add RelayGate observability headers
	req.Header.Set("X-RelayGate-Delivery", event.ID)
	req.Header.Set("X-RelayGate-Attempt", strconv.Itoa(event.Attempts+1))
	req.Header.Set("X-RelayGate-Provider", string(event.Provider))
	req.Header.Set("X-RelayGate-Verified", strconv.Itoa(event.IsVerified))

	// Execute HTTP request
	resp, err := p.client.Do(req)
	if err != nil {
		return p.handleFailure(ctx, event, 0, fmt.Sprintf("network delivery error: %v", err))
	}
	defer resp.Body.Close()

	// Capture response body snippet for error diagnostics
	bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))

	// Success response: 2xx
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		err := p.repo.UpdateEventStatus(ctx, event.ID, model.StatusDelivered, resp.StatusCode, "")
		if err == nil {
			event.Status = model.StatusDelivered
			event.HTTPStatusCode = resp.StatusCode
			event.Attempts++
			event.LastError = ""
			event.FailureCode = ""
			event.ErrorCode = ""
			p.notifyUpdate(event)
		}
		return err
	}

	// Failure response: 4xx, 5xx
	errMsg := fmt.Sprintf("downstream returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodySnippet)))
	return p.handleFailure(ctx, event, resp.StatusCode, errMsg)
}

func (p *Pool) handleFailure(ctx context.Context, event *model.WebhookEvent, statusCode int, errMsg string) error {
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
