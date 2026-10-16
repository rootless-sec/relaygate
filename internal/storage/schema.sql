-- ============================================================================
-- RelayGate Database Schema
-- Embedded SQLite in WAL (Write-Ahead Logging) Mode
-- ============================================================================

CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    target_url TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'generic', -- generic, midtrans, stripe, xendit, github
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,                       -- UUID v4 or ULID
    endpoint_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    headers TEXT NOT NULL,                     -- JSON serialized key-value map
    payload BLOB NOT NULL,                     -- Raw byte payload
    signature TEXT,                            -- Signature header if present
    is_verified INTEGER NOT NULL DEFAULT 0,    -- 0: unverified, 1: valid, -1: invalid
    status TEXT NOT NULL,                      -- 'PENDING', 'DELIVERED', 'FAILED', 'RETRYING'
    http_status_code INTEGER DEFAULT 0,        -- Last response from target
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    failure_code TEXT,                         -- Structured failure reason code
    failed_at DATETIME,                        -- Timestamp when failure occurred
    next_retry_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_events_failure_code ON webhook_events(failure_code);
CREATE INDEX IF NOT EXISTS idx_events_next_retry ON webhook_events(next_retry_at) WHERE status = 'RETRYING';
CREATE INDEX IF NOT EXISTS idx_events_created ON webhook_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_endpoint ON webhook_events(endpoint_id);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    expires_at DATETIME NOT NULL,
    last_active_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_email ON sessions(user_email);

CREATE TABLE IF NOT EXISTS audit_reveals (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    revealed_header_names TEXT NOT NULL, -- comma-separated list of header names ONLY, NO header values!
    ip_address TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_reveals_event ON audit_reveals(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_reveals_created ON audit_reveals(created_at DESC);

CREATE TABLE IF NOT EXISTS email_verifications (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verifications_email ON email_verifications(email);

