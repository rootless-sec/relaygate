package worker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
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

// Pool manages concurrent dispatch workers and retry scheduling
type Pool struct {
	repo     storage.Repository
	verifier *verifier.Engine
	config   Config
	queue    chan string
	client   *http.Client
	rnd      *rand.Rand
	rndMu    sync.Mutex

	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	running atomic.Bool
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
	close(p.queue)
	p.wg.Wait()
}

// Enqueue adds an event ID to the dispatch queue
func (p *Pool) Enqueue(eventID string) bool {
	if !p.running.Load() {
		return false
	}

	select {
	case p.queue <- eventID:
		return true
	default:
		// Queue full: spawn a detached goroutine to deliver without blocking ingest
		go func() {
			select {
			case p.queue <- eventID:
			case <-p.ctx.Done():
			}
		}()
		return true
	}
}

func (p *Pool) workerLoop(workerID int) {
	defer p.wg.Done()

	for {
		select {
		case <-p.ctx.Done():
			return
		case eventID, ok := <-p.queue:
			if !ok {
				return
			}
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

	// 1. Fetch pending retries
	retries, err := p.repo.GetPendingRetries(ctx, 100)
	if err == nil {
		for _, ev := range retries {
			p.Enqueue(ev.ID)
		}
	}

	// 2. Fetch un-dispatched pending events (e.g. from crash or restart)
	pending, err := p.repo.GetPendingEvents(ctx, 100)
	if err == nil {
		for _, ev := range pending {
			p.Enqueue(ev.ID)
		}
	}
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
	event, err := p.repo.GetEventByID(ctx, eventID)
	if err != nil {
		return fmt.Errorf("failed to load event %s: %w", eventID, err)
	}

	// Only process if status is PENDING or RETRYING
	if event.Status != model.StatusPending && event.Status != model.StatusRetrying {
		return nil
	}

	endpoint, err := p.repo.GetEndpointByID(ctx, event.EndpointID)
	if err != nil {
		errMsg := fmt.Sprintf("endpoint %s not found: %v", event.EndpointID, err)
		return p.repo.UpdateEventStatus(ctx, event.ID, model.StatusFailed, 0, errMsg)
	}

	if !endpoint.IsActive {
		errMsg := fmt.Sprintf("endpoint %s is disabled", endpoint.ID)
		return p.repo.UpdateEventStatus(ctx, event.ID, model.StatusFailed, 0, errMsg)
	}

	// Cryptographic verification check
	if p.verifier != nil && event.IsVerified == 0 && endpoint.SecretKey != "" {
		verificationStatus, _ := p.verifier.Verify(endpoint, event.Headers, event.Payload)
		_ = p.repo.UpdateEventVerification(ctx, event.ID, verificationStatus)
		event.IsVerified = verificationStatus
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
		return p.repo.UpdateEventStatus(ctx, event.ID, model.StatusDelivered, resp.StatusCode, "")
	}

	// Failure response: 4xx, 5xx
	errMsg := fmt.Sprintf("downstream returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodySnippet)))
	return p.handleFailure(ctx, event, resp.StatusCode, errMsg)
}

func (p *Pool) handleFailure(ctx context.Context, event *model.WebhookEvent, statusCode int, errMsg string) error {
	nextAttempt := event.Attempts + 1
	if nextAttempt >= event.MaxAttempts {
		// Dead-letter queue transition
		return p.repo.IncrementAttempts(ctx, event.ID, nil, errMsg, statusCode)
	}

	// Calculate exponential backoff with jitter
	backoff := p.calculateBackoff(event.Attempts)
	nextRetryAt := time.Now().UTC().Add(backoff)

	return p.repo.IncrementAttempts(ctx, event.ID, &nextRetryAt, errMsg, statusCode)
}

// CalculateBackoff computes: base * 2^attempt +/- jitter
func (p *Pool) calculateBackoff(attempt int) time.Duration {
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
	if jitteredSec < base.Seconds() {
		jitteredSec = base.Seconds()
	}
	if jitteredSec > maxBackoff.Seconds() {
		jitteredSec = maxBackoff.Seconds()
	}

	return time.Duration(jitteredSec * float64(time.Second))
}
