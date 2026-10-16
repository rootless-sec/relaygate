package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rootless-sec/relaygate/internal/mailer"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/worker"
)

type contextKey string

const SessionContextKey contextKey = "relaygate_session"

var (
	clockMu             sync.RWMutex
	clockFunc           = func() time.Time { return time.Now().UTC() }
	sessionMu           sync.RWMutex
	sessionAbsTimeout   = 12 * time.Hour
	sessionIdleTimeout  = 30 * time.Minute
	allowedOriginsMu    sync.RWMutex
	allowedOrigins      []string
	trustedProxiesMu    sync.RWMutex
	trustedCIDRs        []*net.IPNet
	trustedIPs          []net.IP
)

func init() {
	_ = InitConfig()
}

// InitConfig initializes trusted proxies, session timeouts, and allowed origins from environment
func InitConfig() error {
	ResetClock()
	ResetSessionTimeouts()

	// 1. Session timeouts from env
	if absEnv := os.Getenv("RELAYGATE_SESSION_ABSOLUTE_TIMEOUT"); strings.TrimSpace(absEnv) != "" {
		if d, err := time.ParseDuration(strings.TrimSpace(absEnv)); err == nil && d > 0 {
			sessionMu.Lock()
			sessionAbsTimeout = d
			sessionMu.Unlock()
		}
	}
	if idleEnv := os.Getenv("RELAYGATE_SESSION_IDLE_TIMEOUT"); strings.TrimSpace(idleEnv) != "" {
		if d, err := time.ParseDuration(strings.TrimSpace(idleEnv)); err == nil && d > 0 {
			sessionMu.Lock()
			sessionIdleTimeout = d
			sessionMu.Unlock()
		}
	}

	// 2. Allowed origins for CSRF
	if originsEnv := os.Getenv("RELAYGATE_ALLOWED_ORIGINS"); strings.TrimSpace(originsEnv) != "" {
		var list []string
		for _, o := range strings.Split(originsEnv, ",") {
			if tr := strings.TrimSpace(o); tr != "" {
				list = append(list, tr)
			}
		}
		SetAllowedOrigins(list)
	}

	// 3. Trusted proxies
	return ResetTrustedProxies()
}

// SetClock sets an injectable clock function for deterministic testing
func SetClock(fn func() time.Time) {
	clockMu.Lock()
	defer clockMu.Unlock()
	if fn == nil {
		clockFunc = func() time.Time { return time.Now().UTC() }
	} else {
		clockFunc = fn
	}
}

// ResetClock restores the clock to time.Now().UTC()
func ResetClock() {
	SetClock(nil)
}

// Now returns the current time using the injected clock
func Now() time.Time {
	clockMu.RLock()
	defer clockMu.RUnlock()
	return clockFunc()
}

// SetSessionTimeouts configures absolute and idle session durations
func SetSessionTimeouts(abs, idle time.Duration) {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	if abs > 0 {
		sessionAbsTimeout = abs
	}
	if idle > 0 {
		sessionIdleTimeout = idle
	}
}

// ResetSessionTimeouts resets session timeouts to defaults (12h absolute, 30m idle)
func ResetSessionTimeouts() {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	sessionAbsTimeout = 12 * time.Hour
	sessionIdleTimeout = 30 * time.Minute
}

// GetSessionTimeouts returns current (absolute, idle) timeouts
func GetSessionTimeouts() (time.Duration, time.Duration) {
	sessionMu.RLock()
	defer sessionMu.RUnlock()
	return sessionAbsTimeout, sessionIdleTimeout
}

// GetSessionAbsoluteTimeout returns current absolute session timeout
func GetSessionAbsoluteTimeout() time.Duration {
	sessionMu.RLock()
	defer sessionMu.RUnlock()
	return sessionAbsTimeout
}

// GetSessionIdleTimeout returns current idle session timeout
func GetSessionIdleTimeout() time.Duration {
	sessionMu.RLock()
	defer sessionMu.RUnlock()
	return sessionIdleTimeout
}

// SetAllowedOrigins sets allowed origins for CSRF validation
func SetAllowedOrigins(origins []string) {
	allowedOriginsMu.Lock()
	defer allowedOriginsMu.Unlock()
	allowedOrigins = nil
	for _, o := range origins {
		if tr := strings.TrimSpace(o); tr != "" {
			allowedOrigins = append(allowedOrigins, tr)
		}
	}
}

// GetAllowedOrigins returns configured allowed origins
func GetAllowedOrigins() []string {
	allowedOriginsMu.RLock()
	defer allowedOriginsMu.RUnlock()
	cp := make([]string, len(allowedOrigins))
	copy(cp, allowedOrigins)
	return cp
}

// ResetTrustedProxies resets trusted proxies to default (loopback only) or from env (RELAYGATE_TRUSTED_PROXIES / TRUSTED_PROXIES)
func ResetTrustedProxies() error {
	raw := os.Getenv("RELAYGATE_TRUSTED_PROXIES")
	if strings.TrimSpace(raw) == "" {
		raw = os.Getenv("TRUSTED_PROXIES")
	}
	if strings.TrimSpace(raw) == "" {
		return SetTrustedProxies([]string{"127.0.0.1", "::1"})
	}
	var list []string
	for _, p := range strings.Split(raw, ",") {
		if tr := strings.TrimSpace(p); tr != "" {
			list = append(list, tr)
		}
	}
	return SetTrustedProxies(list)
}

// SetTrustedProxies sets the configurable allowlist of trusted proxies.
// Returns an error if any entry is not a valid IP or CIDR.
func SetTrustedProxies(entries []string) error {
	var newCIDRs []*net.IPNet
	var newIPs []net.IP

	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, cidr, err := net.ParseCIDR(entry)
			if err != nil || cidr == nil {
				return fmt.Errorf("invalid trusted proxy CIDR %q: %w", entry, err)
			}
			newCIDRs = append(newCIDRs, cidr)
		} else {
			ip := net.ParseIP(entry)
			if ip == nil {
				return fmt.Errorf("invalid trusted proxy IP %q", entry)
			}
			newIPs = append(newIPs, ip)
		}
	}

	trustedProxiesMu.Lock()
	trustedCIDRs = newCIDRs
	trustedIPs = newIPs
	trustedProxiesMu.Unlock()
	return nil
}

// IsTrustedProxy checks if an IP/host is a trusted upstream proxy according to the allowlist.
// Default allowlist strictly contains loopback (127.0.0.1, ::1).
func IsTrustedProxy(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip == nil {
		return false
	}

	trustedProxiesMu.RLock()
	defer trustedProxiesMu.RUnlock()

	if len(trustedIPs) == 0 && len(trustedCIDRs) == 0 {
		return ip.IsLoopback()
	}

	for _, tip := range trustedIPs {
		if tip.Equal(ip) {
			return true
		}
	}
	for _, cidr := range trustedCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// ResolveClientIP returns the real client IP, only trusting forwarded headers if direct peer is a trusted proxy.
func ResolveClientIP(r *http.Request) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}

	if IsTrustedProxy(r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				clientIP := strings.TrimSpace(parts[0])
				if net.ParseIP(clientIP) != nil {
					return clientIP
				}
			}
		}
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			if net.ParseIP(xrip) != nil {
				return xrip
			}
		}
	}
	return remoteHost
}

func extractTokenFromRequest(r *http.Request) string {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader != "" {
		if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			return strings.TrimSpace(authHeader[7:])
		}
	}
	if cookie, err := r.Cookie("session"); err == nil && cookie != nil && cookie.Value != "" {
		return strings.TrimSpace(cookie.Value)
	}
	return ""
}

func isHostMatch(originHost, reqHost string) bool {
	if strings.EqualFold(originHost, reqHost) {
		return true
	}
	originHostOnly, _, err1 := net.SplitHostPort(originHost)
	if err1 != nil {
		originHostOnly = originHost
	}
	reqHostOnly, _, err2 := net.SplitHostPort(reqHost)
	if err2 != nil {
		reqHostOnly = reqHost
	}
	if strings.EqualFold(originHostOnly, reqHostOnly) {
		return true
	}
	// Allow Vite dev server on loopback
	if (originHostOnly == "localhost" || originHostOnly == "127.0.0.1") &&
		(reqHostOnly == "localhost" || reqHostOnly == "127.0.0.1") {
		return true
	}
	return false
}

func isAllowedOrigin(rawURL string, effectiveHost string) bool {
	if rawURL == "" {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	if isHostMatch(parsed.Host, effectiveHost) {
		return true
	}
	allowedOriginsMu.RLock()
	defer allowedOriginsMu.RUnlock()
	for _, allowed := range allowedOrigins {
		allowed = strings.TrimSpace(allowed)
		if allowed == "" {
			continue
		}
		if parsedAllowed, err := url.Parse(allowed); err == nil && parsedAllowed.Host != "" {
			if isHostMatch(parsed.Host, parsedAllowed.Host) {
				return true
			}
		} else if strings.EqualFold(parsed.Host, allowed) || strings.EqualFold(rawURL, allowed) {
			return true
		}
	}
	return false
}

func hasSessionCookie(r *http.Request) bool {
	c, err := r.Cookie("session")
	return err == nil && c != nil && strings.TrimSpace(c.Value) != ""
}

// Router sets up control plane HTTP routing and middleware
type Router struct {
	api *API
	mux *http.ServeMux
}

// NewRouter registers all control plane API endpoints
func NewRouter(repo storage.Repository, pool *worker.Pool, hub *Hub, mailerOpt ...*mailer.Mailer) *Router {
	api := NewAPI(repo, pool, hub, mailerOpt...)
	mux := http.NewServeMux()

	// REST Endpoints (Go 1.22+ pattern matching)
	mux.HandleFunc("GET /api/v1/events", api.ListEvents)
	mux.HandleFunc("GET /api/v1/events/{id}", api.GetEvent)
	mux.HandleFunc("POST /api/v1/events/{id}/replay", api.ReplayEvent)
	mux.HandleFunc("POST /api/v1/events/bulk-replay", api.BulkReplay)

	mux.HandleFunc("GET /api/v1/endpoints", api.ListEndpoints)
	mux.HandleFunc("POST /api/v1/endpoints", api.CreateEndpoint)
	mux.HandleFunc("PATCH /api/v1/endpoints/{id}", api.UpdateEndpoint)

	mux.HandleFunc("GET /api/v1/stats", api.GetStats)
	mux.HandleFunc("GET /api/v1/overview", api.GetOverview)
	mux.HandleFunc("GET /api/v1/stream", api.StreamSSE)

	// Auth Endpoints
	mux.HandleFunc("POST /api/v1/auth/register", api.Register)
	mux.HandleFunc("POST /api/v1/auth/verify", api.VerifyCode)
	mux.HandleFunc("POST /api/v1/auth/verify-code", api.VerifyCode)
	mux.HandleFunc("POST /api/v1/auth/resend-code", api.ResendCode)
	mux.HandleFunc("POST /api/v1/auth/login", api.Login)
	mux.HandleFunc("POST /api/v1/auth/logout", api.Logout)

	return &Router{
		api: api,
		mux: mux,
	}
}

// ServeHTTP delegates to internal mux while injecting CORS headers and enforcing security middleware
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Enable CORS for local Vite dev server and cross-origin tools
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Cache-Control")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// SECURITY: Discard untrusted proxy headers from external requests.
	// Headers from proxy are only trusted if the immediate peer is a trusted proxy.
	if !IsTrustedProxy(r.RemoteAddr) {
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("X-Forwarded-Host")
		r.Header.Del("X-Forwarded-Proto")
		r.Header.Del("X-Real-IP")
	}

	// External clients must not be allowed to forge admin role or email via headers.
	r.Header.Del("X-User-Role")
	r.Header.Del("X-Admin")
	r.Header.Del("X-User-Email")

	// Server-side Session / Token Authentication Middleware
	token := extractTokenFromRequest(r)
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	isBearerAuth := authHeader != "" && strings.HasPrefix(strings.ToLower(authHeader), "bearer ")

	if token != "" && rt.api != nil && rt.api.repo != nil {
		sess, err := rt.api.repo.GetSession(r.Context(), token)
		if err == nil && sess != nil {
			now := Now()
			isAbsExpired := now.After(sess.ExpiresAt)
			isIdleExpired := false
			if !sess.LastActiveAt.IsZero() {
				isIdleExpired = now.Sub(sess.LastActiveAt) > GetSessionIdleTimeout()
			} else if !sess.CreatedAt.IsZero() {
				isIdleExpired = now.Sub(sess.CreatedAt) > GetSessionIdleTimeout()
			}

			if isAbsExpired || isIdleExpired {
				_ = rt.api.repo.DeleteSession(r.Context(), token)
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
				writeError(w, http.StatusUnauthorized, "Sesi telah berakhir", nil)
				return
			}

			_ = rt.api.repo.TouchSession(r.Context(), token, now)
			sess.LastActiveAt = now
			ctx := context.WithValue(r.Context(), SessionContextKey, sess)
			r = r.WithContext(ctx)
		} else {
			if isBearerAuth {
				writeError(w, http.StatusUnauthorized, "Sesi tidak valid atau telah kedaluwarsa", nil)
				return
			}
			if hasSessionCookie(r) {
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
			}
		}
	}

	// CSRF Protection:
	// When authenticating via Cookie (and NOT Bearer token), protect against cross-site request forgery
	// on state-mutating methods (POST/PUT/DELETE/PATCH) or sensitive reveal requests (?reveal=1).
	hasCookie := hasSessionCookie(r)
	isCookieAuth := hasCookie && !isBearerAuth

	isStateMutating := r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodDelete || r.Method == http.MethodPatch
	isRevealRequest := r.URL.Query().Get("reveal") == "1" || r.URL.Query().Get("reveal") == "true"

	if isCookieAuth && (isStateMutating || isRevealRequest) {
		// 1. Check Sec-Fetch-Site if provided by modern browsers
		if sfs := r.Header.Get("Sec-Fetch-Site"); strings.EqualFold(sfs, "cross-site") {
			writeError(w, http.StatusForbidden, "CSRF check failed: cross-site request rejected", nil)
			return
		}

		// Effective host (respecting X-Forwarded-Host only from trusted proxy)
		effectiveHost := r.Host
		if IsTrustedProxy(r.RemoteAddr) {
			if xfh := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); xfh != "" {
				effectiveHost = xfh
			}
		}

		// 2. Check Origin header
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !isAllowedOrigin(origin, effectiveHost) {
				writeError(w, http.StatusForbidden, "CSRF check failed: invalid Origin", nil)
				return
			}
		} else {
			// 3. Fallback to Referer header if Origin not set
			referer := r.Header.Get("Referer")
			if referer != "" {
				if !isAllowedOrigin(referer, effectiveHost) {
					writeError(w, http.StatusForbidden, "CSRF check failed: invalid Referer", nil)
					return
				}
			} else {
				// State mutating cookie requests without Origin/Referer are rejected for safety
				writeError(w, http.StatusForbidden, "CSRF check failed: missing Origin or Referer header for cookie authentication", nil)
				return
			}
		}
	}

	rt.mux.ServeHTTP(w, r)
}
