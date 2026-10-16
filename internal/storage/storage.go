package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
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

	// User methods
	SaveUser(ctx context.Context, user *model.User) error
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	GetUserByID(ctx context.Context, id string) (*model.User, error)

	// Session methods
	SaveSession(ctx context.Context, session *model.Session) error
	GetSession(ctx context.Context, token string) (*model.Session, error)
	TouchSession(ctx context.Context, token string, activeAt time.Time) error
	DeleteSession(ctx context.Context, token string) error

	// Audit Reveal methods
	SaveAuditReveal(ctx context.Context, audit *model.AuditReveal) error
	ListAuditReveals(ctx context.Context, eventID string) ([]*model.AuditReveal, error)

	// Verification methods
	SaveEmailVerification(ctx context.Context, v *model.EmailVerification) error
	GetEmailVerification(ctx context.Context, email string) (*model.EmailVerification, error)
	IncrementVerificationAttempts(ctx context.Context, email string) (int, error)
	DeleteEmailVerification(ctx context.Context, email string) error

	// Event methods
	SaveEvent(ctx context.Context, event *model.WebhookEvent) error
	GetEventByID(ctx context.Context, id string) (*model.WebhookEvent, error)
	ListEvents(ctx context.Context, filter ListFilter) ([]*model.WebhookEvent, int64, error)
	UpdateEventStatus(ctx context.Context, id string, status model.EventStatus, httpStatusCode int, lastError string) error
	UpdateEventFailure(ctx context.Context, id string, status model.EventStatus, httpStatusCode int, lastError string, failureCode string, failedAt *time.Time) error
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
	if dbPath == ":memory:" {
		dsn = fmt.Sprintf("file:mem_%d?mode=memory&cache=shared&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", time.Now().UnixNano())
	}
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

// RawDB returns the underlying *sql.DB connection (primarily for tests and direct queries)
func (d *DB) RawDB() *sql.DB {
	return d.db
}

// Migrate executes schema.sql against the SQLite database
func (d *DB) Migrate(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Additive migration: if webhook_events already exists from previous version,
	// add missing columns before executing schemaSQL (which creates indices on them).
	colRows, err := d.db.QueryContext(ctx, "PRAGMA table_info(webhook_events);")
	if err == nil {
		var colCount int
		hasFailureCode := false
		hasFailedAt := false
		for colRows.Next() {
			colCount++
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue any
			if scanErr := colRows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); scanErr == nil {
				if strings.EqualFold(name, "failure_code") {
					hasFailureCode = true
				}
				if strings.EqualFold(name, "failed_at") {
					hasFailedAt = true
				}
			}
		}
		colRows.Close()

		if colCount > 0 {
			if !hasFailureCode {
				_, _ = d.db.ExecContext(ctx, "ALTER TABLE webhook_events ADD COLUMN failure_code TEXT;")
			}
			if !hasFailedAt {
				_, _ = d.db.ExecContext(ctx, "ALTER TABLE webhook_events ADD COLUMN failed_at DATETIME;")
			}
		}
	}

	// Additive migration: check users table for role column
	userColRows, uErr := d.db.QueryContext(ctx, "PRAGMA table_info(users);")
	if uErr == nil {
		hasRole := false
		var uColCount int
		for userColRows.Next() {
			uColCount++
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue any
			if scanErr := userColRows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); scanErr == nil {
				if strings.EqualFold(name, "role") {
					hasRole = true
				}
			}
		}
		userColRows.Close()
		if uColCount > 0 && !hasRole {
			_, _ = d.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';")
		}
	}

	// Check if legacy sessions table has token instead of token_hash or is missing last_active_at
	sessColRows, sErr := d.db.QueryContext(ctx, "PRAGMA table_info(sessions);")
	if sErr == nil {
		hasTokenHash := false
		hasLastActiveAt := false
		var sColCount int
		for sessColRows.Next() {
			sColCount++
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue any
			if scanErr := sessColRows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); scanErr == nil {
				if strings.EqualFold(name, "token_hash") {
					hasTokenHash = true
				}
				if strings.EqualFold(name, "last_active_at") {
					hasLastActiveAt = true
				}
			}
		}
		_ = sessColRows.Close()
		if sColCount > 0 {
			if !hasTokenHash {
				_, _ = d.db.ExecContext(ctx, "DROP TABLE IF EXISTS sessions;")
			} else if !hasLastActiveAt {
				_, _ = d.db.ExecContext(ctx, "ALTER TABLE sessions ADD COLUMN last_active_at DATETIME;")
			}
		}
	}

	_, err = d.db.ExecContext(ctx, schemaSQL)
	if err != nil {
		return fmt.Errorf("migration execution error: %w", err)
	}

	// Ensure default administrator account is seeded with admin role for backward compatibility
	var count int
	row := d.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE email = 'admin@relaygate.local';")
	if err := row.Scan(&count); err == nil && count == 0 {
		hash, err := bcrypt.GenerateFromPassword([]byte("relaygate123"), bcrypt.DefaultCost)
		if err == nil {
			nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
			_, _ = d.db.ExecContext(ctx, `
				INSERT INTO users (id, name, email, password_hash, role, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`, "usr_admin", "Administrator", "admin@relaygate.local", string(hash), "admin", nowStr)
		}
	} else {
		_, _ = d.db.ExecContext(ctx, "UPDATE users SET role = 'admin' WHERE email = 'admin@relaygate.local' AND role != 'admin';")
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

// SaveUser creates or updates a user account
func (d *DB) SaveUser(ctx context.Context, user *model.User) error {
	if user == nil {
		return fmt.Errorf("user cannot be nil")
	}

	if user.ID == "" {
		user.ID = "usr_" + strings.ToLower(uuid.NewString()[:8])
	}
	if user.CreatedAt.IsZero() {
		user.CreatedAt = time.Now().UTC()
	}
	user.Email = strings.ToLower(strings.TrimSpace(user.Email))
	if user.Role == "" {
		user.Role = "viewer"
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO users (id, name, email, password_hash, role, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			email = excluded.email,
			password_hash = excluded.password_hash,
			role = excluded.role;
	`

	createdAtStr := user.CreatedAt.UTC().Format("2006-01-02 15:04:05")
	_, err := d.db.ExecContext(ctx, query,
		user.ID,
		user.Name,
		user.Email,
		user.PasswordHash,
		user.Role,
		createdAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to save user: %w", err)
	}

	return nil
}

// GetUserByEmail retrieves a user by their email address
func (d *DB) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	normEmail := strings.ToLower(strings.TrimSpace(email))
	query := `
		SELECT id, name, email, password_hash, role, created_at
		FROM users
		WHERE LOWER(email) = LOWER(?);
	`

	var u model.User
	var createdAtRaw any

	row := d.db.QueryRowContext(ctx, query, normEmail)
	err := row.Scan(
		&u.ID,
		&u.Name,
		&u.Email,
		&u.PasswordHash,
		&u.Role,
		&createdAtRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("user not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get user by email: %w", err)
	}

	u.CreatedAt = parseSQLTime(createdAtRaw)
	return &u, nil
}

// GetUserByID retrieves a user by their unique ID
func (d *DB) GetUserByID(ctx context.Context, id string) (*model.User, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT id, name, email, password_hash, role, created_at
		FROM users
		WHERE id = ?;
	`

	var u model.User
	var createdAtRaw any

	row := d.db.QueryRowContext(ctx, query, id)
	err := row.Scan(
		&u.ID,
		&u.Name,
		&u.Email,
		&u.PasswordHash,
		&u.Role,
		&createdAtRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("user not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get user by id: %w", err)
	}

	u.CreatedAt = parseSQLTime(createdAtRaw)
	return &u, nil
}

func hashSessionToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// SaveSession persists an active session token (persisted as SHA-256 hash)
func (d *DB) SaveSession(ctx context.Context, session *model.Session) error {
	if session == nil || session.Token == "" {
		return fmt.Errorf("session and token cannot be empty")
	}
	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now().UTC()
	}
	if session.Role == "" {
		session.Role = "viewer"
	}

	if session.LastActiveAt.IsZero() {
		session.LastActiveAt = session.CreatedAt
	}
	if session.LastActiveAt.IsZero() {
		session.LastActiveAt = time.Now().UTC()
	}

	tokenHash := hashSessionToken(session.Token)

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO sessions (token_hash, user_id, user_email, role, expires_at, last_active_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(token_hash) DO UPDATE SET
			user_id = excluded.user_id,
			user_email = excluded.user_email,
			role = excluded.role,
			expires_at = excluded.expires_at,
			last_active_at = excluded.last_active_at;
	`

	expiresAtStr := session.ExpiresAt.UTC().Format("2006-01-02 15:04:05")
	lastActiveAtStr := session.LastActiveAt.UTC().Format("2006-01-02 15:04:05")
	createdAtStr := session.CreatedAt.UTC().Format("2006-01-02 15:04:05")

	_, err := d.db.ExecContext(ctx, query,
		tokenHash,
		session.UserID,
		session.UserEmail,
		session.Role,
		expiresAtStr,
		lastActiveAtStr,
		createdAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to save session: %w", err)
	}
	return nil
}

// GetSession retrieves an active session by token hash
func (d *DB) GetSession(ctx context.Context, token string) (*model.Session, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	tokenHash := hashSessionToken(token)

	query := `
		SELECT user_id, user_email, role, expires_at, last_active_at, created_at
		FROM sessions
		WHERE token_hash = ?;
	`

	var s model.Session
	s.Token = token
	var expiresAtRaw, lastActiveAtRaw, createdAtRaw any

	row := d.db.QueryRowContext(ctx, query, tokenHash)
	err := row.Scan(
		&s.UserID,
		&s.UserEmail,
		&s.Role,
		&expiresAtRaw,
		&lastActiveAtRaw,
		&createdAtRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("session not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	s.ExpiresAt = parseSQLTime(expiresAtRaw)
	s.LastActiveAt = parseSQLTime(lastActiveAtRaw)
	s.CreatedAt = parseSQLTime(createdAtRaw)
	if s.LastActiveAt.IsZero() {
		s.LastActiveAt = s.CreatedAt
	}
	return &s, nil
}

// TouchSession updates last_active_at timestamp for a session
func (d *DB) TouchSession(ctx context.Context, token string, activeAt time.Time) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	tokenHash := hashSessionToken(token)
	activeStr := activeAt.UTC().Format("2006-01-02 15:04:05")
	_, err := d.db.ExecContext(ctx, "UPDATE sessions SET last_active_at = ? WHERE token_hash = ?;", activeStr, tokenHash)
	if err != nil {
		return fmt.Errorf("failed to touch session: %w", err)
	}
	return nil
}

// DeleteSession removes a session by token hash
func (d *DB) DeleteSession(ctx context.Context, token string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	tokenHash := hashSessionToken(token)

	_, err := d.db.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash = ?;", tokenHash)
	if err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}
	return nil
}

// SaveAuditReveal records when an admin reveals sensitive headers
func (d *DB) SaveAuditReveal(ctx context.Context, audit *model.AuditReveal) error {
	if audit == nil {
		return fmt.Errorf("audit cannot be nil")
	}
	if audit.ID == "" {
		audit.ID = uuid.NewString()
	}
	if audit.CreatedAt.IsZero() {
		audit.CreatedAt = time.Now().UTC()
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO audit_reveals (id, event_id, user_id, user_email, revealed_header_names, ip_address, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?);
	`

	createdAtStr := audit.CreatedAt.UTC().Format("2006-01-02 15:04:05")
	_, err := d.db.ExecContext(ctx, query,
		audit.ID,
		audit.EventID,
		audit.UserID,
		audit.UserEmail,
		audit.RevealedHeaderNames,
		audit.IPAddress,
		createdAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to save audit reveal: %w", err)
	}
	return nil
}

// ListAuditReveals retrieves audit reveal entries, optionally filtered by eventID
func (d *DB) ListAuditReveals(ctx context.Context, eventID string) ([]*model.AuditReveal, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var rows *sql.Rows
	var err error
	if eventID != "" {
		rows, err = d.db.QueryContext(ctx, `
			SELECT id, event_id, user_id, user_email, revealed_header_names, ip_address, created_at
			FROM audit_reveals
			WHERE event_id = ?
			ORDER BY created_at DESC;
		`, eventID)
	} else {
		rows, err = d.db.QueryContext(ctx, `
			SELECT id, event_id, user_id, user_email, revealed_header_names, ip_address, created_at
			FROM audit_reveals
			ORDER BY created_at DESC;
		`)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to query audit reveals: %w", err)
	}
	defer rows.Close()

	var list []*model.AuditReveal
	for rows.Next() {
		var a model.AuditReveal
		var createdAtRaw any
		if err := rows.Scan(
			&a.ID,
			&a.EventID,
			&a.UserID,
			&a.UserEmail,
			&a.RevealedHeaderNames,
			&a.IPAddress,
			&createdAtRaw,
		); err != nil {
			return nil, fmt.Errorf("failed to scan audit reveal: %w", err)
		}
		a.CreatedAt = parseSQLTime(createdAtRaw)
		list = append(list, &a)
	}
	return list, nil
}

// SaveEmailVerification persists or updates an email verification record
func (d *DB) SaveEmailVerification(ctx context.Context, v *model.EmailVerification) error {
	if v == nil {
		return fmt.Errorf("verification cannot be nil")
	}

	v.Email = strings.ToLower(strings.TrimSpace(v.Email))
	if v.MaxAttempts <= 0 {
		v.MaxAttempts = model.DefaultVerificationMaxAttempts
	}
	now := time.Now().UTC()
	if v.CreatedAt.IsZero() {
		v.CreatedAt = now
	}
	if v.LastSentAt.IsZero() {
		v.LastSentAt = now
	}
	if v.ExpiresAt.IsZero() {
		v.ExpiresAt = now.Add(15 * time.Minute)
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO email_verifications (email, name, password_hash, code, attempts, max_attempts, last_sent_at, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(email) DO UPDATE SET
			name = excluded.name,
			password_hash = excluded.password_hash,
			code = excluded.code,
			attempts = excluded.attempts,
			max_attempts = excluded.max_attempts,
			last_sent_at = excluded.last_sent_at,
			expires_at = excluded.expires_at;
	`

	lastSentStr := v.LastSentAt.UTC().Format("2006-01-02 15:04:05")
	expiresStr := v.ExpiresAt.UTC().Format("2006-01-02 15:04:05")
	createdAtStr := v.CreatedAt.UTC().Format("2006-01-02 15:04:05")

	_, err := d.db.ExecContext(ctx, query,
		v.Email,
		v.Name,
		v.PasswordHash,
		v.Code,
		v.Attempts,
		v.MaxAttempts,
		lastSentStr,
		expiresStr,
		createdAtStr,
	)
	if err != nil {
		return fmt.Errorf("failed to save email verification: %w", err)
	}

	return nil
}

// GetEmailVerification fetches an email verification by email address
func (d *DB) GetEmailVerification(ctx context.Context, email string) (*model.EmailVerification, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	normEmail := strings.ToLower(strings.TrimSpace(email))
	query := `
		SELECT email, name, password_hash, code, attempts, max_attempts, last_sent_at, expires_at, created_at
		FROM email_verifications
		WHERE LOWER(email) = LOWER(?);
	`

	var v model.EmailVerification
	var lastSentRaw, expiresRaw, createdRaw any

	row := d.db.QueryRowContext(ctx, query, normEmail)
	err := row.Scan(
		&v.Email,
		&v.Name,
		&v.PasswordHash,
		&v.Code,
		&v.Attempts,
		&v.MaxAttempts,
		&lastSentRaw,
		&expiresRaw,
		&createdRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("email verification not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get email verification: %w", err)
	}

	v.LastSentAt = parseSQLTime(lastSentRaw)
	v.ExpiresAt = parseSQLTime(expiresRaw)
	v.CreatedAt = parseSQLTime(createdRaw)

	return &v, nil
}

// IncrementVerificationAttempts increments the failed attempt count for an email verification
func (d *DB) IncrementVerificationAttempts(ctx context.Context, email string) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	normEmail := strings.ToLower(strings.TrimSpace(email))
	query := `
		UPDATE email_verifications
		SET attempts = attempts + 1
		WHERE LOWER(email) = LOWER(?);
	`

	_, err := d.db.ExecContext(ctx, query, normEmail)
	if err != nil {
		return 0, fmt.Errorf("failed to increment verification attempts: %w", err)
	}

	var attempts int
	err = d.db.QueryRowContext(ctx, `SELECT attempts FROM email_verifications WHERE LOWER(email) = LOWER(?);`, normEmail).Scan(&attempts)
	if err != nil {
		return 0, fmt.Errorf("failed to read updated attempts: %w", err)
	}

	return attempts, nil
}

// DeleteEmailVerification removes a completed or expired verification record
func (d *DB) DeleteEmailVerification(ctx context.Context, email string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	normEmail := strings.ToLower(strings.TrimSpace(email))
	query := `DELETE FROM email_verifications WHERE LOWER(email) = LOWER(?);`

	_, err := d.db.ExecContext(ctx, query, normEmail)
	if err != nil {
		return fmt.Errorf("failed to delete email verification: %w", err)
	}

	return nil
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
	ev.MaxAttempts = model.NormalizeMaxAttempts(ev.MaxAttempts)
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

	var failedAtStr *string
	if ev.FailedAt != nil {
		s := ev.FailedAt.UTC().Format("2006-01-02 15:04:05")
		failedAtStr = &s
	}
	var failureCodeStr *string
	if ev.FailureCode != "" {
		failureCodeStr = &ev.FailureCode
	} else if ev.Status == model.StatusFailed {
		_, inferredCode := model.InferFailureCode(ev.LastError, ev.HTTPStatusCode, ev.Attempts, ev.IsVerified)
		s := string(inferredCode)
		failureCodeStr = &s
	}

	createdAtStr := ev.CreatedAt.UTC().Format("2006-01-02 15:04:05")
	updatedAtStr := ev.UpdatedAt.UTC().Format("2006-01-02 15:04:05")

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO webhook_events (
			id, endpoint_id, provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
		) VALUES (
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?, ?
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
		failureCodeStr,
		failedAtStr,
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
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
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
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
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
		    attempts = CASE 
		        WHEN ? = 'PENDING' THEN 0 
		        WHEN ? = 'DELIVERED' THEN attempts + 1 
		        ELSE attempts 
		    END,
		    failure_code = CASE WHEN ? = 'PENDING' THEN NULL ELSE failure_code END,
		    failed_at = CASE WHEN ? IN ('PENDING', 'DELIVERED') THEN NULL ELSE failed_at END,
		    next_retry_at = CASE WHEN ? IN ('DELIVERED', 'FAILED', 'PENDING') THEN NULL ELSE next_retry_at END,
		    updated_at = ?
		WHERE id = ?;
	`

	res, err := d.db.ExecContext(ctx, query,
		string(status),
		httpStatusCode,
		lastError,
		string(status),
		string(status),
		string(status),
		string(status),
		string(status),
		nowStr,
		id,
	)
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

// UpdateEventFailure updates event failure state with structured failure_code and failed_at
func (d *DB) UpdateEventFailure(ctx context.Context, id string, status model.EventStatus, httpStatusCode int, lastError string, failureCode string, failedAt *time.Time) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	var failedAtStr string
	if failedAt != nil {
		failedAtStr = failedAt.UTC().Format("2006-01-02 15:04:05")
	} else {
		failedAtStr = nowStr
	}

	if len(lastError) > 4096 {
		lastError = lastError[:4096]
	}

	query := `
		UPDATE webhook_events
		SET status = ?,
		    http_status_code = ?,
		    last_error = ?,
		    failure_code = ?,
		    failed_at = ?,
		    next_retry_at = NULL,
		    updated_at = ?
		WHERE id = ?;
	`

	res, err := d.db.ExecContext(ctx, query, string(status), httpStatusCode, lastError, failureCode, failedAtStr, nowStr, id)
	if err != nil {
		return fmt.Errorf("failed to update event failure: %w", err)
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
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
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
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
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
	var attemptsNull, maxAttemptsNull sql.NullInt64
	err := d.db.QueryRowContext(ctx, `SELECT attempts, max_attempts FROM webhook_events WHERE id = ?;`, id).Scan(&attemptsNull, &maxAttemptsNull)
	if err != nil {
		return fmt.Errorf("failed to read event for increment: %w", err)
	}
	attempts := int(attemptsNull.Int64)
	maxAttempts := model.NormalizeMaxAttempts(int(maxAttemptsNull.Int64))

	newAttempts := attempts + 1
	if newAttempts > maxAttempts {
		newAttempts = maxAttempts
	}
	var newStatus model.EventStatus
	var nextRetryStr *string
	var failedAtStr *string
	var failureCodeStr *string

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")

	if newAttempts >= maxAttempts {
		newStatus = model.StatusFailed
		nextRetryStr = nil
		failedAtStr = &nowStr
		_, inferredCode := model.InferFailureCode(lastError, httpStatusCode, newAttempts, 1)
		s := string(inferredCode)
		failureCodeStr = &s
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

	query := `
		UPDATE webhook_events
		SET attempts = ?,
		    status = ?,
		    next_retry_at = ?,
		    last_error = ?,
		    http_status_code = ?,
		    failure_code = CASE WHEN ? = 'FAILED' THEN COALESCE(?, failure_code) ELSE failure_code END,
		    failed_at = CASE WHEN ? = 'FAILED' THEN COALESCE(?, failed_at, ?) ELSE failed_at END,
		    updated_at = ?
		WHERE id = ?;
	`

	_, err = d.db.ExecContext(ctx, query,
		newAttempts, string(newStatus), nextRetryStr, lastError, httpStatusCode,
		string(newStatus), failureCodeStr,
		string(newStatus), failedAtStr, nowStr,
		nowStr, id)
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
			COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
			COALESCE(SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END), 0) AS retrying,
			COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed
		FROM webhook_events;
	`

	var stats model.StatsSummary
	row := d.db.QueryRowContext(ctx, query)
	err := row.Scan(&stats.TotalEvents, &stats.DeliveredEvents, &stats.PendingEvents, &stats.RetryingEvents, &stats.FailedEvents)
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
	var maxAttemptsNull sql.NullInt64
	var lastErrNull sql.NullString
	var failureCodeNull sql.NullString
	var failedAtNull sql.NullString
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
		&maxAttemptsNull,
		&lastErrNull,
		&failureCodeNull,
		&failedAtNull,
		&nextRetryNull,
		&createdAtRaw,
		&updatedAtRaw,
	)
	if err != nil {
		return nil, err
	}

	ev.Provider = model.ProviderType(providerStr)
	ev.Status = model.EventStatus(statusStr)
	ev.MaxAttempts = model.NormalizeMaxAttempts(int(maxAttemptsNull.Int64))

	if sigNull.Valid {
		ev.Signature = sigNull.String
	}
	if httpStatusNull.Valid {
		ev.HTTPStatusCode = int(httpStatusNull.Int64)
	}
	if lastErrNull.Valid {
		ev.LastError = lastErrNull.String
	}

	if failureCodeNull.Valid && failureCodeNull.String != "" {
		ev.FailureCode = failureCodeNull.String
		ev.ErrorCode = failureCodeNull.String
	} else if ev.Status == model.StatusFailed || ev.Status == model.StatusRetrying {
		// Canonical single fallback mapping for legacy rows without failure_code
		_, inferredCode := model.InferFailureCode(ev.LastError, ev.HTTPStatusCode, ev.Attempts, ev.IsVerified)
		ev.FailureCode = string(inferredCode)
		ev.ErrorCode = string(inferredCode)
	}

	if failedAtNull.Valid && failedAtNull.String != "" {
		t := parseSQLTime(failedAtNull.String)
		if !t.IsZero() {
			ev.FailedAt = &t
		}
	} else if ev.Status == model.StatusFailed {
		// Fallback for legacy rows lacking failed_at: use UpdatedAt or CreatedAt
		t := parseSQLTime(updatedAtRaw)
		if !t.IsZero() {
			ev.FailedAt = &t
		} else {
			ev.FailedAt = &ev.CreatedAt
		}
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
