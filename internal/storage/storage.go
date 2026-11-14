package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	EndpointID  string
	Status      model.EventStatus
	Provider    model.ProviderType
	FailureCode string
	Search      string
	Limit       int
	Offset      int
}

// Repository defines the persistence interface for RelayGate
type Repository interface {
	Close() error
	Migrate(ctx context.Context) error

	// Endpoint methods
	SaveEndpoint(ctx context.Context, endpoint *model.Endpoint) error
	GetEndpointByID(ctx context.Context, id string) (*model.Endpoint, error)
	GetEndpointByAgentToken(ctx context.Context, token string) (*model.Endpoint, error)
	RotateEndpointAgentToken(ctx context.Context, endpointID string) (string, error)
	ListEndpoints(ctx context.Context) ([]*model.Endpoint, error)
	DeleteEndpoint(ctx context.Context, id string) error

	// User methods
	SaveUser(ctx context.Context, user *model.User) error
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	GetUserByID(ctx context.Context, id string) (*model.User, error)
	UpdateUserProfile(ctx context.Context, id string, name string, avatarURL string) error
	UpdateUserPassword(ctx context.Context, id string, passwordHash string) error

	// Session methods
	SaveSession(ctx context.Context, session *model.Session) error
	GetSession(ctx context.Context, token string) (*model.Session, error)
	TouchSession(ctx context.Context, token string, activeAt time.Time) error
	DeleteSession(ctx context.Context, token string) error
	DeleteSessionsByUserIDExcept(ctx context.Context, userID string, keepTokenHash string) error

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

	// Backup, Pruning, Idempotency & Delivery Logs methods
	Backup(ctx context.Context, destPath string) (*model.BackupResult, error)
	PruneDeliveredEvents(ctx context.Context, olderThan time.Time) (int64, error)
	CheckAndSetIdempotency(ctx context.Context, endpointID, key, eventID string) (string, bool, error)
	SaveDeliveryLog(ctx context.Context, eventID string, log *model.DeliveryLogEntry) error
	ListDeliveryLogs(ctx context.Context, eventID string) ([]model.DeliveryLogEntry, error)
	DeferRetry(ctx context.Context, eventID string, nextRetryAt time.Time, errMsg string, statusCode int) error
	GetThroughput(ctx context.Context, windowMinutes int) ([]model.ThroughputBucket, error)
	GetEndpointBreakdown(ctx context.Context) ([]model.EndpointBreakdown, error)
	GetRecentFailedEvents(ctx context.Context, limit int) ([]*model.WebhookEvent, error)
}

// DB represents a SQLite database connection wrapper
type DB struct {
	db       *sql.DB
	mu       sync.RWMutex
	backupMu sync.Mutex
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

	// Use a single pooled SQLite connection per DB instance to prevent multi-connection
	// WAL pragma/file-lock contention in pure-Go modernc.org/sqlite on Windows.
	maxConns := 1
	db.SetMaxOpenConns(maxConns)
	db.SetMaxIdleConns(maxConns)

	storageDB := &DB{db: db}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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

	// Additive migration: if endpoints already exists from previous version, add missing columns.
	epColRows, epErr := d.db.QueryContext(ctx, "PRAGMA table_info(endpoints);")
	if epErr == nil {
		epCols := make(map[string]bool)
		var epColCount int
		for epColRows.Next() {
			epColCount++
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue any
			if scanErr := epColRows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); scanErr == nil {
				epCols[strings.ToLower(name)] = true
			}
		}
		epColRows.Close()
		if epColCount > 0 {
			epAdditions := []struct {
				name string
				ddl  string
			}{
				{"destinations_json", "ALTER TABLE endpoints ADD COLUMN destinations_json TEXT NOT NULL DEFAULT '[]';"},
				{"wrap_envelope", "ALTER TABLE endpoints ADD COLUMN wrap_envelope INTEGER NOT NULL DEFAULT 0;"},
				{"notification_url", "ALTER TABLE endpoints ADD COLUMN notification_url TEXT NOT NULL DEFAULT '';"},
				{"telegram_webhook", "ALTER TABLE endpoints ADD COLUMN telegram_webhook TEXT NOT NULL DEFAULT '';"},
				{"telegram_chat_id", "ALTER TABLE endpoints ADD COLUMN telegram_chat_id TEXT NOT NULL DEFAULT '';"},
				{"discord_webhook", "ALTER TABLE endpoints ADD COLUMN discord_webhook TEXT NOT NULL DEFAULT '';"},
				{"slack_webhook", "ALTER TABLE endpoints ADD COLUMN slack_webhook TEXT NOT NULL DEFAULT '';"},
				{"notification_email", "ALTER TABLE endpoints ADD COLUMN notification_email TEXT NOT NULL DEFAULT '';"},
				{"agent_token", "ALTER TABLE endpoints ADD COLUMN agent_token TEXT NOT NULL DEFAULT '';"},
			}
			for _, add := range epAdditions {
				if !epCols[add.name] {
					_, _ = d.db.ExecContext(ctx, add.ddl)
				}
			}
		}
	}

	// Additive migration: if webhook_events already exists from previous version,
	// add missing columns before executing schemaSQL (which creates indices on them).
	colRows, err := d.db.QueryContext(ctx, "PRAGMA table_info(webhook_events);")
	if err == nil {
		var colCount int
		evCols := make(map[string]bool)
		for colRows.Next() {
			colCount++
			var cid int
			var name, colType string
			var notNull, pk int
			var dfltValue any
			if scanErr := colRows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); scanErr == nil {
				evCols[strings.ToLower(name)] = true
			}
		}
		colRows.Close()

		if colCount > 0 {
			evAdditions := []struct {
				name string
				ddl  string
			}{
				{"failure_code", "ALTER TABLE webhook_events ADD COLUMN failure_code TEXT;"},
				{"failed_at", "ALTER TABLE webhook_events ADD COLUMN failed_at DATETIME;"},
				{"target_url", "ALTER TABLE webhook_events ADD COLUMN target_url TEXT NOT NULL DEFAULT '';"},
				{"parent_event_id", "ALTER TABLE webhook_events ADD COLUMN parent_event_id TEXT NOT NULL DEFAULT '';"},
				{"external_id", "ALTER TABLE webhook_events ADD COLUMN external_id TEXT NOT NULL DEFAULT '';"},
			}
			for _, add := range evAdditions {
				if !evCols[add.name] {
					_, _ = d.db.ExecContext(ctx, add.ddl)
				}
			}
		}
	}

	// Additive migration: check users table for role and avatar_url columns
	userColRows, uErr := d.db.QueryContext(ctx, "PRAGMA table_info(users);")
	if uErr == nil {
		hasRole := false
		hasAvatarURL := false
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
				if strings.EqualFold(name, "avatar_url") {
					hasAvatarURL = true
				}
			}
		}
		userColRows.Close()
		if uColCount > 0 {
			if !hasRole {
				_, _ = d.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';")
			}
			if !hasAvatarURL {
				_, _ = d.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT '';")
			}
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

	// Backfill missing agent tokens for legacy endpoints so every endpoint has a CLI agent token.
	backfillRows, bfErr := d.db.QueryContext(ctx, "SELECT id FROM endpoints WHERE COALESCE(agent_token, '') = '';")
	if bfErr == nil {
		var missingIDs []string
		for backfillRows.Next() {
			var id string
			if sErr := backfillRows.Scan(&id); sErr == nil && id != "" {
				missingIDs = append(missingIDs, id)
			}
		}
		backfillRows.Close()
		for _, id := range missingIDs {
			_, _ = d.db.ExecContext(ctx, "UPDATE endpoints SET agent_token = ? WHERE id = ? AND COALESCE(agent_token, '') = '';", GenerateAgentToken(), id)
		}
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

// GenerateAgentToken creates a cryptographically random token for outbound relaygate-agent sessions.
func GenerateAgentToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "agt_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	}
	return "agt_" + hex.EncodeToString(b)
}

const endpointSelectColumns = `
	id, name, secret_key, target_url,
	COALESCE(destinations_json, '[]'),
	COALESCE(wrap_envelope, 0),
	COALESCE(notification_url, ''),
	COALESCE(telegram_webhook, ''),
	COALESCE(telegram_chat_id, ''),
	COALESCE(discord_webhook, ''),
	COALESCE(slack_webhook, ''),
	COALESCE(notification_email, ''),
	COALESCE(agent_token, ''),
	provider, is_active, created_at
`

func scanEndpoint(s rowScanner) (*model.Endpoint, error) {
	var ep model.Endpoint
	var destJSONStr string
	var wrapInt int
	var providerStr string
	var isActiveInt int
	var createdAtRaw any

	err := s.Scan(
		&ep.ID,
		&ep.Name,
		&ep.SecretKey,
		&ep.TargetURL,
		&destJSONStr,
		&wrapInt,
		&ep.NotificationURL,
		&ep.TelegramWebhook,
		&ep.TelegramChatID,
		&ep.DiscordWebhook,
		&ep.SlackWebhook,
		&ep.NotificationEmail,
		&ep.AgentToken,
		&providerStr,
		&isActiveInt,
		&createdAtRaw,
	)
	if err != nil {
		return nil, err
	}

	if destJSONStr != "" && destJSONStr != "[]" {
		_ = json.Unmarshal([]byte(destJSONStr), &ep.Destinations)
		for _, dest := range ep.Destinations {
			if dest.URL != "" {
				ep.TargetURLs = append(ep.TargetURLs, dest.URL)
			}
		}
	}
	ep.WrapEnvelope = wrapInt == 1
	ep.Provider = model.ProviderType(providerStr)
	ep.IsActive = isActiveInt == 1
	ep.CreatedAt = parseSQLTime(createdAtRaw)
	return &ep, nil
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
	if strings.TrimSpace(ep.AgentToken) == "" {
		ep.AgentToken = GenerateAgentToken()
	}

	if len(ep.Destinations) == 0 && len(ep.TargetURLs) > 0 {
		for _, u := range ep.TargetURLs {
			if trimmed := strings.TrimSpace(u); trimmed != "" {
				ep.Destinations = append(ep.Destinations, model.EndpointDestination{URL: trimmed})
			}
		}
	}
	if ep.TargetURL == "" && len(ep.Destinations) > 0 {
		ep.TargetURL = ep.Destinations[0].URL
	}

	destJSON, err := json.Marshal(ep.Destinations)
	if err != nil || ep.Destinations == nil {
		destJSON = []byte("[]")
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO endpoints (
			id, name, secret_key, target_url, destinations_json, wrap_envelope,
			notification_url, telegram_webhook, telegram_chat_id, discord_webhook, slack_webhook, notification_email,
			agent_token, provider, is_active, created_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			secret_key = excluded.secret_key,
			target_url = excluded.target_url,
			destinations_json = excluded.destinations_json,
			wrap_envelope = excluded.wrap_envelope,
			notification_url = excluded.notification_url,
			telegram_webhook = excluded.telegram_webhook,
			telegram_chat_id = excluded.telegram_chat_id,
			discord_webhook = excluded.discord_webhook,
			slack_webhook = excluded.slack_webhook,
			notification_email = excluded.notification_email,
			agent_token = CASE WHEN endpoints.agent_token != '' THEN endpoints.agent_token ELSE excluded.agent_token END,
			provider = excluded.provider,
			is_active = excluded.is_active;
	`

	isActiveInt := 0
	if ep.IsActive {
		isActiveInt = 1
	}
	wrapInt := 0
	if ep.WrapEnvelope {
		wrapInt = 1
	}

	createdAtStr := ep.CreatedAt.UTC().Format("2006-01-02 15:04:05")

	_, err = d.db.ExecContext(ctx, query,
		ep.ID,
		ep.Name,
		ep.SecretKey,
		ep.TargetURL,
		string(destJSON),
		wrapInt,
		ep.NotificationURL,
		ep.TelegramWebhook,
		ep.TelegramChatID,
		ep.DiscordWebhook,
		ep.SlackWebhook,
		ep.NotificationEmail,
		ep.AgentToken,
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

	query := "SELECT " + endpointSelectColumns + " FROM endpoints WHERE id = ?;"
	ep, err := scanEndpoint(d.db.QueryRowContext(ctx, query, id))
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("endpoint not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get endpoint by id: %w", err)
	}
	return ep, nil
}

// GetEndpointByAgentToken authenticates an agent token in constant time and returns its endpoint.
func (d *DB) GetEndpointByAgentToken(ctx context.Context, token string) (*model.Endpoint, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("agent token is required")
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	query := "SELECT " + endpointSelectColumns + " FROM endpoints WHERE COALESCE(agent_token, '') != '';"
	rows, err := d.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query agent endpoints: %w", err)
	}
	defer rows.Close()

	tokenBytes := []byte(token)
	var matched *model.Endpoint
	for rows.Next() {
		ep, scanErr := scanEndpoint(rows)
		if scanErr != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(ep.AgentToken), tokenBytes) == 1 {
			matched = ep
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating agent endpoints: %w", err)
	}
	if matched == nil {
		return nil, fmt.Errorf("invalid agent token")
	}
	return matched, nil
}

// RotateEndpointAgentToken generates and persists a new agent token for an endpoint.
func (d *DB) RotateEndpointAgentToken(ctx context.Context, endpointID string) (string, error) {
	if strings.TrimSpace(endpointID) == "" {
		return "", fmt.Errorf("endpoint id is required")
	}

	newToken := GenerateAgentToken()

	d.mu.Lock()
	defer d.mu.Unlock()

	res, err := d.db.ExecContext(ctx, "UPDATE endpoints SET agent_token = ? WHERE id = ?;", newToken, endpointID)
	if err != nil {
		return "", fmt.Errorf("failed to rotate agent token: %w", err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return "", fmt.Errorf("endpoint not found")
	}
	return newToken, nil
}

// ListEndpoints retrieves all registered endpoints
func (d *DB) ListEndpoints(ctx context.Context) ([]*model.Endpoint, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := "SELECT " + endpointSelectColumns + " FROM endpoints ORDER BY created_at DESC;"

	rows, err := d.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list endpoints: %w", err)
	}
	defer rows.Close()

	var endpoints []*model.Endpoint
	for rows.Next() {
		ep, err := scanEndpoint(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan endpoint row: %w", err)
		}
		endpoints = append(endpoints, ep)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("endpoints row iteration error: %w", err)
	}

	return endpoints, nil
}

// DeleteEndpoint removes an endpoint and its associated delivered/failed events by its unique identifier
func (d *DB) DeleteEndpoint(ctx context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Atomic deletion protection: reject deletion if active events are queued or in-flight
	var activeCount int
	err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE endpoint_id = ? AND status IN ('PENDING', 'RETRYING');", id).Scan(&activeCount)
	if err != nil {
		return fmt.Errorf("failed to verify active events: %w", err)
	}
	if activeCount > 0 {
		return fmt.Errorf("endpoint has active events in queue (status PENDING or RETRYING)")
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM idempotency_keys WHERE endpoint_id = ?;", id); err != nil {
		return fmt.Errorf("failed to delete associated idempotency keys: %w", err)
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM webhook_events WHERE endpoint_id = ?;", id); err != nil {
		return fmt.Errorf("failed to delete associated webhook events: %w", err)
	}

	res, err := tx.ExecContext(ctx, "DELETE FROM endpoints WHERE id = ?;", id)
	if err != nil {
		return fmt.Errorf("failed to delete endpoint: %w", err)
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return fmt.Errorf("endpoint not found")
	}

	return tx.Commit()
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
		INSERT INTO users (id, name, email, password_hash, role, avatar_url, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			email = excluded.email,
			password_hash = excluded.password_hash,
			role = excluded.role,
			avatar_url = excluded.avatar_url;
	`

	createdAtStr := user.CreatedAt.UTC().Format("2006-01-02 15:04:05")
	_, err := d.db.ExecContext(ctx, query,
		user.ID,
		user.Name,
		user.Email,
		user.PasswordHash,
		user.Role,
		user.AvatarURL,
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
		SELECT id, name, email, password_hash, role, COALESCE(avatar_url, ''), created_at
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
		&u.AvatarURL,
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
		SELECT id, name, email, password_hash, role, COALESCE(avatar_url, ''), created_at
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
		&u.AvatarURL,
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

// UpdateUserProfile updates user's nickname/name and optional avatar URL
func (d *DB) UpdateUserProfile(ctx context.Context, id string, name string, avatarURL string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	query := `UPDATE users SET name = ?, avatar_url = ? WHERE id = ?;`
	res, err := d.db.ExecContext(ctx, query, strings.TrimSpace(name), strings.TrimSpace(avatarURL), id)
	if err != nil {
		return fmt.Errorf("failed to update user profile: %w", err)
	}
	rowsAffected, err := res.RowsAffected()
	if err == nil && rowsAffected == 0 {
		return fmt.Errorf("user not found with id: %s", id)
	}
	return nil
}

// UpdateUserPassword updates a user's password hash
func (d *DB) UpdateUserPassword(ctx context.Context, id string, passwordHash string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	query := `UPDATE users SET password_hash = ? WHERE id = ?;`
	res, err := d.db.ExecContext(ctx, query, passwordHash, id)
	if err != nil {
		return fmt.Errorf("failed to update user password: %w", err)
	}
	rowsAffected, err := res.RowsAffected()
	if err == nil && rowsAffected == 0 {
		return fmt.Errorf("user not found with id: %s", id)
	}
	return nil
}

// HashSessionToken computes SHA-256 hex string of a session token
func HashSessionToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func hashSessionToken(token string) string {
	return HashSessionToken(token)
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

// DeleteSessionsByUserIDExcept removes all sessions for a user except the one matching keepTokenHash
func (d *DB) DeleteSessionsByUserIDExcept(ctx context.Context, userID string, keepTokenHash string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	query := `DELETE FROM sessions WHERE user_id = ? AND token_hash != ?;`
	_, err := d.db.ExecContext(ctx, query, userID, keepTokenHash)
	if err != nil {
		return fmt.Errorf("failed to revoke user sessions: %w", err)
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
		s := ev.NextRetryAt.UTC().Format("2006-01-02 15:04:05.000")
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
			id, endpoint_id, target_url, parent_event_id, external_id,
			provider, source_ip, headers, payload,
			signature, is_verified, status, http_status_code, attempts,
			max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
		) VALUES (
			?, ?, ?, ?, ?,
			?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?, ?
		);
	`

	_, err = d.db.ExecContext(ctx, query,
		ev.ID,
		ev.EndpointID,
		ev.TargetURL,
		ev.ParentEventID,
		ev.ExternalID,
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

const eventSelectColumns = `
	id, endpoint_id,
	COALESCE(target_url, ''), COALESCE(parent_event_id, ''), COALESCE(external_id, ''),
	provider, source_ip, headers, payload,
	signature, is_verified, status, http_status_code, attempts,
	max_attempts, last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
`

// GetEventByID retrieves an event by its ID (or falls back to external_id / idempotency_key / parent_event_id lookup)
func (d *DB) GetEventByID(ctx context.Context, id string) (*model.WebhookEvent, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `SELECT ` + eventSelectColumns + ` FROM webhook_events WHERE id = ?;`
	ev, err := scanEvent(d.db.QueryRowContext(ctx, query, id))
	if err == nil {
		d.populateEventDeliveryLogsLocked(ctx, ev)
		return ev, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// Fallback 1: lookup by external_id (prefer primary event where parent_event_id = '')
	extQuery := `SELECT ` + eventSelectColumns + ` FROM webhook_events WHERE external_id = ? ORDER BY CASE WHEN parent_event_id = '' THEN 0 ELSE 1 END, created_at DESC LIMIT 1;`
	ev, extErr := scanEvent(d.db.QueryRowContext(ctx, extQuery, id))
	if extErr == nil {
		d.populateEventDeliveryLogsLocked(ctx, ev)
		return ev, nil
	}

	// Fallback 2: lookup via idempotency_keys table
	var mappedEventID string
	if idempErr := d.db.QueryRowContext(ctx, `SELECT event_id FROM idempotency_keys WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1;`, id).Scan(&mappedEventID); idempErr == nil && mappedEventID != "" {
		if ev2, err2 := scanEvent(d.db.QueryRowContext(ctx, query, mappedEventID)); err2 == nil {
			d.populateEventDeliveryLogsLocked(ctx, ev2)
			return ev2, nil
		}
		id = mappedEventID
	}

	// Fallback 3: lookup surviving child fan-out event if primary event was pruned
	childQuery := `SELECT ` + eventSelectColumns + ` FROM webhook_events WHERE parent_event_id = ? ORDER BY created_at ASC LIMIT 1;`
	if evChild, childErr := scanEvent(d.db.QueryRowContext(ctx, childQuery, id)); childErr == nil {
		d.populateEventDeliveryLogsLocked(ctx, evChild)
		return evChild, nil
	}

	return nil, err
}

// ListChildEvents retrieves all fan-out child events associated with a primary parent event ID.
func (d *DB) ListChildEvents(ctx context.Context, parentEventID string) ([]*model.WebhookEvent, error) {
	parentEventID = strings.TrimSpace(parentEventID)
	if parentEventID == "" {
		return nil, nil
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `SELECT ` + eventSelectColumns + ` FROM webhook_events WHERE parent_event_id = ? ORDER BY created_at ASC;`
	rows, err := d.db.QueryContext(ctx, query, parentEventID)
	if err != nil {
		return nil, fmt.Errorf("failed to query child events: %w", err)
	}
	defer rows.Close()

	var children []*model.WebhookEvent
	for rows.Next() {
		ev, scanErr := scanEvent(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("failed to scan child event: %w", scanErr)
		}
		children = append(children, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	d.populateEventDeliveryLogsLocked(ctx, children...)
	return children, nil
}

func (d *DB) populateEventDeliveryLogsLocked(ctx context.Context, events ...*model.WebhookEvent) {
	for _, ev := range events {
		if ev == nil || ev.ID == "" {
			continue
		}
		rows, err := d.db.QueryContext(ctx, `
			SELECT id, event_id, attempt, status_code, duration_ms, COALESCE(error, ''), created_at
			FROM delivery_logs
			WHERE event_id = ?
			ORDER BY attempt ASC, id ASC;
		`, ev.ID)
		if err != nil {
			continue
		}
		var entries []model.DeliveryLogEntry
		for rows.Next() {
			var entry model.DeliveryLogEntry
			var createdAtRaw any
			if scanErr := rows.Scan(
				&entry.ID,
				&entry.EventID,
				&entry.Attempt,
				&entry.StatusCode,
				&entry.DurationMs,
				&entry.Error,
				&createdAtRaw,
			); scanErr == nil {
				entry.CreatedAt = parseSQLTime(createdAtRaw)
				entries = append(entries, entry)
			}
		}
		_ = rows.Close()
		if len(entries) > 0 {
			ev.DeliveryLog = entries
		} else if ev.DeliveryLog == nil {
			ev.DeliveryLog = []model.DeliveryLogEntry{}
		}
	}
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

	if filter.Provider != "" {
		conditions = append(conditions, "provider = ?")
		args = append(args, string(filter.Provider))
	}

	if filter.FailureCode != "" {
		conditions = append(conditions, "failure_code = ?")
		args = append(args, filter.FailureCode)
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
		SELECT %s
		FROM webhook_events
		%s
		ORDER BY created_at DESC
		LIMIT ? OFFSET ?;
	`, eventSelectColumns, whereClause)

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

	d.populateEventDeliveryLogsLocked(ctx, events...)

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

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05.000")
	query := `
		SELECT ` + eventSelectColumns + `
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
		SELECT ` + eventSelectColumns + `
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
			s := nextRetryAt.UTC().Format("2006-01-02 15:04:05.000")
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

// Backup creates an online hot database snapshot using native SQLite VACUUM INTO.
// It acquires backupMu to serialize backups while leaving d.mu untouched, ensuring
// concurrent webhook ingestion and worker transactions are never stalled.
func (d *DB) Backup(ctx context.Context, destPath string) (*model.BackupResult, error) {
	d.backupMu.Lock()
	defer d.backupMu.Unlock()

	destPath = strings.TrimSpace(destPath)
	if destPath == "" {
		timestamp := time.Now().UTC().Format("20060102_150405")
		destPath = filepath.Join("data", "backups", fmt.Sprintf("relaygate_backup_%s.db", timestamp))
	}

	absPath, err := validateBackupDestinationPath(destPath)
	if err != nil {
		return nil, err
	}

	parentDir := filepath.Dir(absPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create backup destination directory: %w", err)
	}

	// Enforce foreign key consistency check prior to snapshot creation
	fkRows, fkErr := d.db.QueryContext(ctx, "PRAGMA foreign_key_check;")
	if fkErr != nil {
		return nil, fmt.Errorf("failed to verify foreign key consistency: %w", fkErr)
	}
	hasFKViolation := fkRows.Next()
	_ = fkRows.Close()
	if hasFKViolation {
		return nil, fmt.Errorf("database foreign key consistency check failed prior to backup")
	}

	// SQLite VACUUM INTO fails if destination already exists, so remove if present
	if _, err := os.Stat(absPath); err == nil {
		if err := os.Remove(absPath); err != nil {
			return nil, fmt.Errorf("failed to remove existing backup file: %w", err)
		}
	}

	startTime := time.Now()
	_, err = d.db.ExecContext(ctx, "VACUUM INTO ?", absPath)
	if err != nil {
		_ = os.Remove(absPath)
		return nil, fmt.Errorf("sqlite hot backup execution failed: %w", err)
	}
	durationMs := time.Since(startTime).Milliseconds()

	fi, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat created backup file: %w", err)
	}

	return &model.BackupResult{
		DestinationPath: absPath,
		SizeBytes:       fi.Size(),
		DurationMs:      durationMs,
		CreatedAt:       startTime.UTC(),
	}, nil
}

// validateBackupDestinationPath validates and confines the target backup file path.
// It rejects null bytes, directory traversal ('..'), system root destinations, and
// ensures the destination is confined within the application working tree or OS temp directory.
func validateBackupDestinationPath(destPath string) (string, error) {
	if strings.ContainsRune(destPath, 0) {
		return "", fmt.Errorf("invalid destination path: contains null byte")
	}

	if strings.Contains(destPath, "..") {
		return "", fmt.Errorf("directory traversal forbidden: destination path cannot contain '..'")
	}

	cleanPath := filepath.Clean(destPath)
	absPath, err := filepath.Abs(cleanPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve absolute backup path: %w", err)
	}

	// Prohibit placing backup directly at filesystem root or drive root
	parentDir := filepath.Dir(absPath)
	vol := filepath.VolumeName(absPath)
	if parentDir == "/" || parentDir == "\\" || (vol != "" && (parentDir == vol || parentDir == vol+"\\" || parentDir == vol+"/")) {
		return "", fmt.Errorf("backup destination cannot be located directly in root directory: %s", absPath)
	}

	// Prohibit known OS system directory hierarchies
	absLower := strings.ToLower(absPath)
	if sysRoot := os.Getenv("SystemRoot"); sysRoot != "" {
		if strings.HasPrefix(absLower, strings.ToLower(sysRoot)) {
			return "", fmt.Errorf("backup destination cannot target system directory: %s", absPath)
		}
	}
	if progFiles := os.Getenv("ProgramFiles"); progFiles != "" {
		if strings.HasPrefix(absLower, strings.ToLower(progFiles)) {
			return "", fmt.Errorf("backup destination cannot target program files: %s", absPath)
		}
	}
	if progFilesX86 := os.Getenv("ProgramFiles(x86)"); progFilesX86 != "" {
		if strings.HasPrefix(absLower, strings.ToLower(progFilesX86)) {
			return "", fmt.Errorf("backup destination cannot target program files: %s", absPath)
		}
	}

	unixSystemDirs := []string{"/etc", "/bin", "/sbin", "/usr", "/boot", "/dev", "/proc", "/sys", "/root", "/var/run"}
	for _, sysDir := range unixSystemDirs {
		if absPath == sysDir || strings.HasPrefix(absPath, sysDir+"/") {
			return "", fmt.Errorf("backup destination cannot target system directory: %s", absPath)
		}
	}

	// Confinement check: path must be inside current working directory tree or temp directory
	isConfined := false
	cwd, err := os.Getwd()
	if err == nil {
		cwdAbs, cErr := filepath.Abs(cwd)
		if cErr == nil {
			rel, rErr := filepath.Rel(cwdAbs, absPath)
			if rErr == nil && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
				isConfined = true
			}
		}
	}
	if !isConfined {
		tmpDir := os.TempDir()
		tmpAbs, tErr := filepath.Abs(tmpDir)
		if tErr == nil {
			rel, rErr := filepath.Rel(tmpAbs, absPath)
			if rErr == nil && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
				isConfined = true
			}
		}
	}

	if !isConfined {
		return "", fmt.Errorf("backup destination path is outside allowed roots (working directory or temp directory): %s", destPath)
	}

	return absPath, nil
}

// PruneDeliveredEvents removes DELIVERED events older than the specified timestamp.
// It strictly preserves FAILED (DLQ) events for operator triage, as well as PENDING and RETRYING events.
func (d *DB) PruneDeliveredEvents(ctx context.Context, olderThan time.Time) (int64, error) {
	if olderThan.IsZero() {
		return 0, fmt.Errorf("olderThan timestamp must not be zero")
	}

	cutoff := olderThan.UTC()

	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.db.QueryContext(ctx, `SELECT id, created_at FROM webhook_events WHERE status = 'DELIVERED';`)
	if err != nil {
		return 0, fmt.Errorf("failed to query delivered events for pruning: %w", err)
	}

	var idsToDelete []string
	for rows.Next() {
		var id string
		var createdAtRaw any
		if scanErr := rows.Scan(&id, &createdAtRaw); scanErr == nil {
			createdTime := parseSQLTime(createdAtRaw)
			if !createdTime.IsZero() && createdTime.Before(cutoff) {
				idsToDelete = append(idsToDelete, id)
			}
		}
	}
	_ = rows.Close()

	if len(idsToDelete) == 0 {
		return 0, nil
	}

	var totalDeleted int64
	for _, id := range idsToDelete {
		res, execErr := d.db.ExecContext(ctx, `DELETE FROM webhook_events WHERE id = ? AND status = 'DELIVERED';`, id)
		if execErr != nil {
			return totalDeleted, fmt.Errorf("failed to prune delivered event %s: %w", id, execErr)
		}
		if affected, rErr := res.RowsAffected(); rErr == nil {
			totalDeleted += affected
		}
	}

	return totalDeleted, nil
}

// CheckAndSetIdempotency atomically checks if (endpointID, key) has already been processed.
// If it exists, returns (existingEventID, true, nil).
// Otherwise inserts (endpointID, key, eventID) and returns (eventID, false, nil).
func (d *DB) CheckAndSetIdempotency(ctx context.Context, endpointID, key, eventID string) (string, bool, error) {
	endpointID = strings.TrimSpace(endpointID)
	key = strings.TrimSpace(key)
	if endpointID == "" || key == "" {
		return eventID, false, nil
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	var existingID string
	err := d.db.QueryRowContext(ctx, `SELECT event_id FROM idempotency_keys WHERE endpoint_id = ? AND idempotency_key = ?;`, endpointID, key).Scan(&existingID)
	if err == nil && existingID != "" {
		return existingID, true, nil
	}

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05")
	_, err = d.db.ExecContext(ctx, `
		INSERT INTO idempotency_keys (endpoint_id, idempotency_key, event_id, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(endpoint_id, idempotency_key) DO NOTHING;
	`, endpointID, key, eventID, nowStr)
	if err != nil {
		return "", false, fmt.Errorf("failed to insert idempotency key: %w", err)
	}

	return eventID, false, nil
}

// SaveDeliveryLog records an attempt result into delivery_logs table
func (d *DB) SaveDeliveryLog(ctx context.Context, eventID string, log *model.DeliveryLogEntry) error {
	if log == nil {
		return fmt.Errorf("delivery log entry cannot be nil")
	}
	if strings.TrimSpace(eventID) == "" {
		return fmt.Errorf("eventID cannot be empty")
	}

	if log.ID == "" {
		log.ID = uuid.NewString()
	}
	if log.EventID == "" {
		log.EventID = eventID
	}
	if log.CreatedAt.IsZero() {
		log.CreatedAt = time.Now().UTC()
	}

	createdAtStr := log.CreatedAt.UTC().Format("2006-01-02 15:04:05")

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `
		INSERT INTO delivery_logs (id, event_id, attempt, status_code, duration_ms, error, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?);
	`
	_, err := d.db.ExecContext(ctx, query, log.ID, eventID, log.Attempt, log.StatusCode, log.DurationMs, log.Error, createdAtStr)
	if err != nil {
		return fmt.Errorf("failed to save delivery log: %w", err)
	}

	return nil
}

// ListDeliveryLogs retrieves all delivery attempts for an event ordered by attempt ASC
func (d *DB) ListDeliveryLogs(ctx context.Context, eventID string) ([]model.DeliveryLogEntry, error) {
	if strings.TrimSpace(eventID) == "" {
		return []model.DeliveryLogEntry{}, nil
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT id, event_id, attempt, status_code, duration_ms, error, created_at
		FROM delivery_logs
		WHERE event_id = ?
		ORDER BY attempt ASC;
	`
	rows, err := d.db.QueryContext(ctx, query, eventID)
	if err != nil {
		return nil, fmt.Errorf("failed to list delivery logs: %w", err)
	}
	defer rows.Close()

	logs := make([]model.DeliveryLogEntry, 0)
	for rows.Next() {
		var entry model.DeliveryLogEntry
		var createdAtRaw any
		if err := rows.Scan(&entry.ID, &entry.EventID, &entry.Attempt, &entry.StatusCode, &entry.DurationMs, &entry.Error, &createdAtRaw); err != nil {
			return nil, fmt.Errorf("failed to scan delivery log: %w", err)
		}
		entry.CreatedAt = parseSQLTime(createdAtRaw)
		logs = append(logs, entry)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during delivery logs iteration: %w", err)
	}

	return logs, nil
}

// DeferRetry updates an event to RETRYING status with a future next_retry_at timestamp
// without incrementing the attempts counter (non-penalizing deferral).
func (d *DB) DeferRetry(ctx context.Context, eventID string, nextRetryAt time.Time, errMsg string, statusCode int) error {
	if strings.TrimSpace(eventID) == "" {
		return fmt.Errorf("eventID cannot be empty")
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if len(errMsg) > 4096 {
		errMsg = errMsg[:4096]
	}

	nextRetryStr := nextRetryAt.UTC().Format("2006-01-02 15:04:05.000")
	updatedAtStr := time.Now().UTC().Format("2006-01-02 15:04:05")

	query := `
		UPDATE webhook_events
		SET status = 'RETRYING',
		    next_retry_at = ?,
		    last_error = ?,
		    http_status_code = ?,
		    updated_at = ?
		WHERE id = ?;
	`
	res, err := d.db.ExecContext(ctx, query, nextRetryStr, errMsg, statusCode, updatedAtStr, eventID)
	if err != nil {
		return fmt.Errorf("failed to defer retry: %w", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("event not found: %s", eventID)
	}

	return nil
}

// GetThroughput calculates per-minute event throughput and failure counts over windowMinutes.
func (d *DB) GetThroughput(ctx context.Context, windowMinutes int) ([]model.ThroughputBucket, error) {
	if windowMinutes <= 0 {
		windowMinutes = 12
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	now := time.Now().UTC()
	startTime := now.Add(-time.Duration(windowMinutes) * time.Minute)
	startTimeStr := startTime.Format("2006-01-02 15:04:05")
	nowStr := now.Format("2006-01-02 15:04:05")

	buckets := make([]model.ThroughputBucket, windowMinutes)
	for i := 0; i < windowMinutes; i++ {
		minsAgo := windowMinutes - 1 - i
		label := fmt.Sprintf("-%dm", minsAgo)
		if minsAgo == 0 {
			label = "now"
		}
		buckets[i] = model.ThroughputBucket{
			Index: i,
			Label: label,
		}
	}

	query := `
		SELECT
			CAST((strftime('%s', ?) - strftime('%s', created_at)) / 60 AS INTEGER) AS mins_ago,
			COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN status IN ('FAILED', 'RETRYING') THEN 1 ELSE 0 END), 0) AS failed
		FROM webhook_events
		WHERE created_at >= ? AND created_at <= ?
		GROUP BY mins_ago;
	`

	rows, err := d.db.QueryContext(ctx, query, nowStr, startTimeStr, nowStr)
	if err != nil {
		return nil, fmt.Errorf("failed to query throughput: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var minsAgo int
		var total, failed int
		if err := rows.Scan(&minsAgo, &total, &failed); err != nil {
			return nil, fmt.Errorf("failed to scan throughput row: %w", err)
		}
		if minsAgo >= 0 && minsAgo < windowMinutes {
			idx := windowMinutes - 1 - minsAgo
			buckets[idx].Total = total
			buckets[idx].Failed = failed
		}
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during throughput iteration: %w", err)
	}

	return buckets, nil
}

// GetEndpointBreakdown calculates delivery stats and success rates per endpoint via SQL aggregation.
func (d *DB) GetEndpointBreakdown(ctx context.Context) ([]model.EndpointBreakdown, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT
			e.id,
			e.name,
			e.provider,
			COUNT(w.id) AS total,
			COALESCE(SUM(CASE WHEN w.status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS delivered,
			COALESCE(SUM(CASE WHEN w.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed
		FROM endpoints e
		LEFT JOIN webhook_events w ON e.id = w.endpoint_id
		GROUP BY e.id, e.name, e.provider
		ORDER BY e.created_at DESC;
	`

	rows, err := d.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query endpoint breakdown: %w", err)
	}
	defer rows.Close()

	breakdownList := make([]model.EndpointBreakdown, 0)
	for rows.Next() {
		var eb model.EndpointBreakdown
		var providerStr string
		if err := rows.Scan(&eb.ID, &eb.Name, &providerStr, &eb.Total, &eb.Delivered, &eb.Failed); err != nil {
			return nil, fmt.Errorf("failed to scan endpoint breakdown row: %w", err)
		}
		eb.Provider = model.ProviderType(providerStr)
		if eb.Total > 0 {
			eb.SuccessRate = int(float64(eb.Delivered) / float64(eb.Total) * 100)
		}
		breakdownList = append(breakdownList, eb)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during endpoint breakdown iteration: %w", err)
	}

	return breakdownList, nil
}

// GetRecentFailedEvents retrieves the most recent failed events directly via indexed SQL query.
func (d *DB) GetRecentFailedEvents(ctx context.Context, limit int) ([]*model.WebhookEvent, error) {
	if limit <= 0 {
		limit = 5
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `
		SELECT ` + eventSelectColumns + `
		FROM webhook_events
		WHERE status = 'FAILED'
		ORDER BY created_at DESC
		LIMIT ?;
	`

	rows, err := d.db.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query recent failed events: %w", err)
	}
	defer rows.Close()

	var events []*model.WebhookEvent
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan recent failed event: %w", err)
		}
		events = append(events, ev)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during recent failed events iteration: %w", err)
	}

	d.populateEventDeliveryLogsLocked(ctx, events...)

	return events, nil
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
		&ev.TargetURL,
		&ev.ParentEventID,
		&ev.ExternalID,
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
	if idx := strings.Index(s, " m="); idx != -1 {
		s = strings.TrimSpace(s[:idx])
	}

	formats := []string{
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
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

	// Handle Go's time.Time string format with multi-word timezone name (e.g., "2026-11-14 21:25:00.123 +0700 +07")
	parts := strings.Fields(s)
	if len(parts) >= 3 {
		prefix := parts[0] + " " + parts[1] + " " + parts[2]
		for _, format := range []string{"2006-01-02 15:04:05.999999999 -0700", "2006-01-02 15:04:05 -0700"} {
			if t, err := time.Parse(format, prefix); err == nil {
				return t.UTC()
			}
		}
	}

	return time.Time{}
}
