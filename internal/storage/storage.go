package storage

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/rootless-sec/relaygate/internal/model"
)

//go:embed schema.sql
var schemaSQL string

// ListFilter represents filtering and pagination options for events query
type ListFilter struct {
	EndpointID string
	Status     model.EventStatus
	Search     string
	Limit      int
	Offset     int
}

// Repository defines the persistence interface for RelayGate
type Repository interface {
	Close() error
	Migrate(ctx context.Context) error

	// Endpoint methods
	SaveEndpoint(ctx context.Context, endpoint *model.Endpoint) error
	GetEndpointByID(ctx context.Context, id string) (*model.Endpoint, error)
	ListEndpoints(ctx context.Context) ([]*model.Endpoint, error)

	// Event methods
	SaveEvent(ctx context.Context, event *model.WebhookEvent) error
	GetEventByID(ctx context.Context, id string) (*model.WebhookEvent, error)
	ListEvents(ctx context.Context, filter ListFilter) ([]*model.WebhookEvent, int64, error)
	UpdateEventStatus(ctx context.Context, id string, status model.EventStatus, httpStatusCode int, lastError string) error
	UpdateEventVerification(ctx context.Context, id string, isVerified int) error
	GetPendingRetries(ctx context.Context, limit int) ([]*model.WebhookEvent, error)
	GetPendingEvents(ctx context.Context, limit int) ([]*model.WebhookEvent, error)
	IncrementAttempts(ctx context.Context, id string, nextRetryAt *time.Time, lastError string, httpStatusCode int) error
	GetStats(ctx context.Context) (*model.StatsSummary, error)
	Checkpoint(ctx context.Context) error
}

// DB represents a SQLite database connection wrapper
type DB struct {
	db *sql.DB
	mu sync.RWMutex
}

// Open opens a SQLite database in WAL mode and runs migrations
func Open(dbPath string) (*DB, error) {
	if dbPath != ":memory:" {
		dir := filepath.Dir(dbPath)
		if err := os.MkdirAll(dir, 0755); err != nil && dir != "." {
			return nil, fmt.Errorf("failed to create db directory: %w", err)
		}
	}

	// SQLite connection string with WAL and busy timeout pragmas
	dsn := fmt.Sprintf("%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	// SQLite WAL mode supports concurrent readers; serialize writes with Go mutex
	maxConns := 10
	db.SetMaxOpenConns(maxConns)
	db.SetMaxIdleConns(maxConns)

	storageDB := &DB{db: db}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := storageDB.Migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to run database migration: %w", err)
	}

	return storageDB, nil
}

// Close flushes the WAL checkpoint and closes the database connection
func (d *DB) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Truncate and consolidate WAL back into the main database file on shutdown
	_, _ = d.db.Exec("PRAGMA wal_checkpoint(TRUNCATE);")
	return d.db.Close()
}

// Checkpoint flushes SQLite WAL pages to the main database file
func (d *DB) Checkpoint(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.db.ExecContext(ctx, "PRAGMA wal_checkpoint(PASSIVE);")
	if err != nil {
		return fmt.Errorf("wal checkpoint failed: %w", err)
	}
	return nil
}

// Migrate executes schema.sql against the SQLite database
func (d *DB) Migrate(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.db.ExecContext(ctx, schemaSQL)
	if err != nil {
		return fmt.Errorf("migration execution error: %w", err)
	}
	return nil
}

// SaveEndpoint creates or updates an endpoint
func (d *DB) SaveEndpoint(ctx context.Context, ep *model.Endpoint) error {
	if ep == nil {
		return fmt.Errorf("endpoint cannot be nil")
	}

	if ep.ID == "" {
		ep.ID = uuid.NewString()
	}
	if ep.CreatedAt.IsZero() {
		ep.CreatedAt = time.Now().UTC()
	}
	if ep.Provider == "" {
		ep.Provider = model.ProviderGeneric
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO endpoints (id, name, secret_key, target_url, provider, is_active, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			secret_key = excluded.secret_key,
			target_url = excluded.target_url,
			provider = excluded.provider,
			is_active = excluded.is_active;
	`

	isActiveInt := 0
	if ep.IsActive {
		isActiveInt = 1
	}

	createdAtStr := ep.CreatedAt.UTC().Format("2006-01-02 15:04:05")

	_, err := d.db.ExecContext(ctx, query,
		ep.ID,
		ep.Name,
		ep.SecretKey,
		ep.TargetURL,
		string(ep.Provider),
		isActiveInt,
		createdAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to save endpoint: %w", err)
	}

	return nil
}

// GetEndpointByID fetches an endpoint by its unique identifier
func (d *DB) GetEndpointByID(ctx context.Context, id string) (*model.Endpoint, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT id, name, secret_key, target_url, provider, is_active, created_at
		FROM endpoints
		WHERE id = ?;
	`

	var ep model.Endpoint
	var providerStr string
	var isActiveInt int
	var createdAtRaw any

	row := d.db.QueryRowContext(ctx, query, id)
	err := row.Scan(
		&ep.ID,
		&ep.Name,
		&ep.SecretKey,
		&ep.TargetURL,
		&providerStr,
		&isActiveInt,
		&createdAtRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("endpoint not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get endpoint by id: %w", err)
	}

	ep.Provider = model.ProviderType(providerStr)
	ep.IsActive = isActiveInt == 1
	ep.CreatedAt = parseSQLTime(createdAtRaw)

	return &ep, nil
}

// ListEndpoints retrieves all registered endpoints
func (d *DB) ListEndpoints(ctx context.Context) ([]*model.Endpoint, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT id, name, secret_key, target_url, provider, is_active, created_at
		FROM endpoints
		ORDER BY created_at DESC;
	`

	rows, err := d.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list endpoints: %w", err)
	}
	defer rows.Close()

	var endpoints []*model.Endpoint
	for rows.Next() {
		var ep model.Endpoint
		var providerStr string
		var isActiveInt int
		var createdAtRaw any

		if err := rows.Scan(
			&ep.ID,
			&ep.Name,
			&ep.SecretKey,
			&ep.TargetURL,
			&providerStr,
			&isActiveInt,
			&createdAtRaw,
		); err != nil {
			return nil, fmt.Errorf("failed to scan endpoint row: %w", err)
		}

		ep.Provider = model.ProviderType(providerStr)
		ep.IsActive = isActiveInt == 1
		ep.CreatedAt = parseSQLTime(createdAtRaw)
		endpoints = append(endpoints, &ep)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("endpoints row iteration error: %w", err)
	}

	return endpoints, nil
}

// SaveEvent persists a new webhook event into SQLite queue in WAL mode
func (d *DB) SaveEvent(ctx context.Context, ev *model.WebhookEvent) error {
	if ev == nil {
		return fmt.Errorf("event cannot be nil")
	}

	if ev.ID == "" {
		ev.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = now
	}
	if ev.UpdatedAt.IsZero() {
		ev.UpdatedAt = now
	}
	if ev.MaxAttempts <= 0 {
		ev.MaxAttempts = 5
	}
	if ev.Status == "" {
		ev.Status = model.StatusPending
	}
	if ev.Provider == "" {
		ev.Provider = model.ProviderGeneric
	}
	if ev.Payload == nil {
		ev.Payload = []byte{}
	}
	if ev.Headers == nil {
		ev.Headers = make(map[string]string)
	}

	headersJSON, err := json.Marshal(ev.Headers)
	if err != nil {
		return fmt.Errorf("failed to marshal headers to json: %w", err)
	}

	var nextRetryStr *string
	if ev.NextRetryAt != nil {
		s := ev.NextRetryAt.UTC().Format("2006-01-02 15:04:05")
		nextRetryStr = &s
	}

	createdAtStr := ev.CreatedAt.UTC().Format("2006-01-02 15:04:05")
	updatedAtStr := ev.UpdatedAt.UTC().Format("2006-01-02 15:04:05")

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO webhook_events (
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, next_retry_at, created_at, updated_at
		) VALUES (
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?
		);
	`

	_, err = d.db.ExecContext(ctx, query,
		ev.ID,
		ev.EndpointID,
		string(ev.Provider),
		ev.SourceIP,
		string(headersJSON),
		ev.Payload,
		ev.Signature,
		ev.IsVerified,
		string(ev.Status),
		ev.HTTPStatusCode,
		ev.Attempts,
		ev.MaxAttempts,
		ev.LastError,
		nextRetryStr,
		createdAtStr,
		updatedAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to insert webhook event: %w", err)
	}

	return nil
}

// GetEventByID retrieves an event by its ID
func (d *DB) GetEventByID(ctx context.Context, id string) (*model.WebhookEvent, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, next_retry_at, created_at, updated_at
		FROM webhook_events
		WHERE id = ?;
	`

	row := d.db.QueryRowContext(ctx, query, id)
	return scanEvent(row)
}

// ListEvents queries webhook events based on filter options and calculates total count
func (d *DB) ListEvents(ctx context.Context, filter ListFilter) ([]*model.WebhookEvent, int64, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var conditions []string
	var args []any

	if filter.EndpointID != "" {
		conditions = append(conditions, "endpoint_id = ?")
		args = append(args, filter.EndpointID)
	}

	if filter.Status != "" {
		conditions = append(conditions, "status = ?")
		args = append(args, string(filter.Status))
	}

	if filter.Search != "" {
		conditions = append(conditions, "(id LIKE ? OR source_ip LIKE ? OR last_error LIKE ?)")
		searchPattern := "%" + filter.Search + "%"
		args = append(args, searchPattern, searchPattern, searchPattern)
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = "WHERE " + strings.Join(conditions, " AND ")
	}

	// Count total
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM webhook_events %s;", whereClause)
	var total int64
	if err := d.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count webhook events: %w", err)
	}

	// Pagination
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	query := fmt.Sprintf(`
		SELECT
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, next_retry_at, created_at, updated_at
		FROM webhook_events
		%s
		ORDER BY created_at DESC
		LIMIT ? OFFSET ?;
	`, whereClause)

	dataArgs := append(args, limit, offset)
	rows, err := d.db.QueryContext(ctx, query, dataArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query webhook events: %w", err)
	}
	defer rows.Close()

	var events []*model.WebhookEvent
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to scan webhook event: %w", err)
		}
		events = append(events, ev)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error during events iteration: %w", err)
	}

	return events, total, nil
}

// UpdateEventStatus updates event status, last HTTP status code, last error and updated_at
func (d *DB) UpdateEventStatus(ctx context.Context, id string, status model.EventStatus, httpStatusCode int, lastError string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	if len(lastError) > 4096 {
		lastError = lastError[:4096]
	}

	query := `
		UPDATE webhook_events
		SET status = ?,
		    http_status_code = ?,
		    last_error = ?,
		    next_retry_at = CASE WHEN ? IN ('DELIVERED', 'FAILED', 'PENDING') THEN NULL ELSE next_retry_at END,
		    updated_at = ?
		WHERE id = ?;
	`

	res, err := d.db.ExecContext(ctx, query, string(status), httpStatusCode, lastError, string(status), nowStr, id)
	if err != nil {
		return fmt.Errorf("failed to update event status: %w", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("event not found: %s", id)
	}

	return nil
}

// UpdateEventVerification updates verification state of an event
func (d *DB) UpdateEventVerification(ctx context.Context, id string, isVerified int) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	query := `
		UPDATE webhook_events
		SET is_verified = ?, updated_at = ?
		WHERE id = ?;
	`

	_, err := d.db.ExecContext(ctx, query, isVerified, nowStr, id)
	if err != nil {
		return fmt.Errorf("failed to update event verification: %w", err)
	}
	return nil
}

// GetPendingRetries retrieves events in RETRYING status whose next_retry_at is due
func (d *DB) GetPendingRetries(ctx context.Context, limit int) ([]*model.WebhookEvent, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if limit <= 0 {
		limit = 50
	}

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	query := `
		SELECT
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, next_retry_at, created_at, updated_at
		FROM webhook_events
		WHERE status = 'RETRYING' AND (next_retry_at IS NULL OR next_retry_at <= ?)
		ORDER BY next_retry_at ASC
		LIMIT ?;
	`

	rows, err := d.db.QueryContext(ctx, query, nowStr, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query pending retries: %w", err)
	}
	defer rows.Close()

	var events []*model.WebhookEvent
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan pending retry event: %w", err)
		}
		events = append(events, ev)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pending retries iteration error: %w", err)
	}

	return events, nil
}

// GetPendingEvents retrieves events in PENDING status that have not yet been dispatched
func (d *DB) GetPendingEvents(ctx context.Context, limit int) ([]*model.WebhookEvent, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if limit <= 0 {
		limit = 50
	}

	query := `
		SELECT
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, next_retry_at, created_at, updated_at
		FROM webhook_events
		WHERE status = 'PENDING'
		ORDER BY created_at ASC
		LIMIT ?;
	`

	rows, err := d.db.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query pending events: %w", err)
	}
	defer rows.Close()

	var events []*model.WebhookEvent
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan pending event: %w", err)
		}
		events = append(events, ev)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pending events iteration error: %w", err)
	}

	return events, nil
}

// IncrementAttempts updates attempts, next retry time, error, and transitions status to FAILED or RETRYING
func (d *DB) IncrementAttempts(ctx context.Context, id string, nextRetryAt *time.Time, lastError string, httpStatusCode int) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Read current attempts and max_attempts
	var attempts, maxAttempts int
	err := d.db.QueryRowContext(ctx, `SELECT attempts, max_attempts FROM webhook_events WHERE id = ?;`, id).Scan(&attempts, &maxAttempts)
	if err != nil {
		return fmt.Errorf("failed to read event for increment: %w", err)
	}

	newAttempts := attempts + 1
	var newStatus model.EventStatus
	var nextRetryStr *string

	if newAttempts >= maxAttempts {
		newStatus = model.StatusFailed
		nextRetryStr = nil
	} else {
		newStatus = model.StatusRetrying
		if nextRetryAt != nil {
			s := nextRetryAt.UTC().Format("2006-01-02 15:04:05")
			nextRetryStr = &s
		}
	}

	if len(lastError) > 4096 {
		lastError = lastError[:4096]
	}

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	query := `
		UPDATE webhook_events
		SET attempts = ?, status = ?, next_retry_at = ?, last_error = ?, http_status_code = ?, updated_at = ?
		WHERE id = ?;
	`

	_, err = d.db.ExecContext(ctx, query, newAttempts, string(newStatus), nextRetryStr, lastError, httpStatusCode, nowStr, id)
	if err != nil {
		return fmt.Errorf("failed to increment attempts: %w", err)
	}

	return nil
}

// GetStats returns aggregated metrics across all webhook events
func (d *DB) GetStats(ctx context.Context) (*model.StatsSummary, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT
			COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS delivered,
			COALESCE(SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END), 0) AS retrying,
			COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed
		FROM webhook_events;
	`

	var stats model.StatsSummary
	row := d.db.QueryRowContext(ctx, query)
	err := row.Scan(&stats.TotalEvents, &stats.DeliveredEvents, &stats.RetryingEvents, &stats.FailedEvents)
	if err != nil {
		return nil, fmt.Errorf("failed to get stats: %w", err)
	}

	return &stats, nil
}

// rowScanner represents a database row or rows scanner interface
type rowScanner interface {
	Scan(dest ...any) error
}

func scanEvent(s rowScanner) (*model.WebhookEvent, error) {
	var ev model.WebhookEvent
	var providerStr string
	var headersStr string
	var sigNull sql.NullString
	var statusStr string
	var httpStatusNull sql.NullInt64
	var lastErrNull sql.NullString
	var nextRetryNull sql.NullString
	var createdAtRaw any
	var updatedAtRaw any

	err := s.Scan(
		&ev.ID,
		&ev.EndpointID,
		&providerStr,
		&ev.SourceIP,
		&headersStr,
		&ev.Payload,
		&sigNull,
		&ev.IsVerified,
		&statusStr,
		&httpStatusNull,
		&ev.Attempts,
		&ev.MaxAttempts,
		&lastErrNull,
		&nextRetryNull,
		&createdAtRaw,
		&updatedAtRaw,
	)
	if err != nil {
		return nil, err
	}

	ev.Provider = model.ProviderType(providerStr)
	ev.Status = model.EventStatus(statusStr)

	if sigNull.Valid {
		ev.Signature = sigNull.String
	}
	if httpStatusNull.Valid {
		ev.HTTPStatusCode = int(httpStatusNull.Int64)
	}
	if lastErrNull.Valid {
		ev.LastError = lastErrNull.String
	}

	if headersStr != "" {
		var h map[string]string
		if err := json.Unmarshal([]byte(headersStr), &h); err == nil {
			ev.Headers = h
		} else {
			ev.Headers = make(map[string]string)
		}
	} else {
		ev.Headers = make(map[string]string)
	}

	if nextRetryNull.Valid && nextRetryNull.String != "" {
		t := parseSQLTime(nextRetryNull.String)
		if !t.IsZero() {
			ev.NextRetryAt = &t
		}
	}

	ev.CreatedAt = parseSQLTime(createdAtRaw)
	ev.UpdatedAt = parseSQLTime(updatedAtRaw)

	return &ev, nil
}

func parseSQLTime(val any) time.Time {
	if val == nil {
		return time.Time{}
	}

	switch v := val.(type) {
	case time.Time:
		return v.UTC()
	case string:
		return parseTimeString(v)
	case []byte:
		return parseTimeString(string(v))
	default:
		return time.Time{}
	}
}

func parseTimeString(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}

	formats := []string{
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05.999999999",
		time.RFC3339,
		time.RFC3339Nano,
		"2006-01-02T15:04:05",
		"2006-01-02T15:04:05Z",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, s); err == nil {
			return t.UTC()
		}
	}

	return time.Time{}
}
