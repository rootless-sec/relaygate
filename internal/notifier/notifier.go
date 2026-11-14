package notifier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
)

const DefaultCooldownWindow = 5 * time.Minute

// AlertPayload represents the incident notification payload sent to webhook sinks.
type AlertPayload struct {
	EndpointID   string `json:"endpoint_id"`
	EndpointName string `json:"endpoint_name"`
	EventID      string `json:"event_id,omitempty"`
	Reason       string `json:"reason"`
	Timestamp    string `json:"timestamp"`
	ChatID       string `json:"chat_id,omitempty"`
	Text         string `json:"text"`
	Content      string `json:"content"`
}

// Manager dispatches real-time DLQ and circuit breaker incident notifications
// with a thread-safe per-endpoint cooldown digest window.
type Manager struct {
	mu         sync.Mutex
	lastAlerts map[string]time.Time
	cooldown   time.Duration
	client     *http.Client
	smtpAddr   string
	smtpFrom   string
}

// NewManager creates a new notification manager with the given per-endpoint cooldown window.
func NewManager(cooldown time.Duration) *Manager {
	if cooldown <= 0 {
		cooldown = DefaultCooldownWindow
	}
	return &Manager{
		lastAlerts: make(map[string]time.Time),
		cooldown:   cooldown,
		client: &http.Client{
			Timeout: 3 * time.Second,
		},
	}
}

// SetSMTPConfig configures an explicit SMTP server address (host:port) and sender address.
func (m *Manager) SetSMTPConfig(addr, from string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.smtpAddr = strings.TrimSpace(addr)
	m.smtpFrom = strings.TrimSpace(from)
}

// HasChannels reports whether the endpoint has at least one notification sink configured.
func HasChannels(ep *model.Endpoint) bool {
	if ep == nil {
		return false
	}
	return strings.TrimSpace(ep.NotificationURL) != "" ||
		strings.TrimSpace(ep.TelegramWebhook) != "" ||
		strings.TrimSpace(ep.DiscordWebhook) != "" ||
		strings.TrimSpace(ep.SlackWebhook) != "" ||
		strings.TrimSpace(ep.NotificationEmail) != ""
}

// HasChannels reports whether the endpoint has at least one notification sink configured.
func (m *Manager) HasChannels(ep *model.Endpoint) bool {
	return HasChannels(ep)
}

// NotifyIncident dispatches an incident alert to all configured channels on the endpoint
// if the endpoint is not currently within its cooldown window.
func (m *Manager) NotifyIncident(ctx context.Context, ep *model.Endpoint, eventID string, reason string) {
	if m == nil || !HasChannels(ep) {
		return
	}

	now := time.Now().UTC()

	m.mu.Lock()
	if last, exists := m.lastAlerts[ep.ID]; exists && now.Sub(last) < m.cooldown {
		m.mu.Unlock()
		return
	}
	m.lastAlerts[ep.ID] = now
	smtpAddr := m.smtpAddr
	smtpFrom := m.smtpFrom
	m.mu.Unlock()

	ts := now.Format(time.RFC3339)
	summary := fmt.Sprintf("[RelayGate Alert] Endpoint %s (%s) incident: %s at %s", ep.Name, ep.ID, reason, ts)

	payload := AlertPayload{
		EndpointID:   ep.ID,
		EndpointName: ep.Name,
		EventID:      eventID,
		Reason:       reason,
		Timestamp:    ts,
		ChatID:       ep.TelegramChatID,
		Text:         summary,
		Content:      summary,
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return
	}

	urls := []string{
		strings.TrimSpace(ep.NotificationURL),
		strings.TrimSpace(ep.TelegramWebhook),
		strings.TrimSpace(ep.DiscordWebhook),
		strings.TrimSpace(ep.SlackWebhook),
	}

	emailTarget := strings.TrimSpace(ep.NotificationEmail)
	if strings.HasPrefix(emailTarget, "http://") || strings.HasPrefix(emailTarget, "https://") {
		urls = append(urls, emailTarget)
		emailTarget = ""
	}

	seen := make(map[string]bool)
	for _, targetURL := range urls {
		if targetURL == "" || seen[targetURL] {
			continue
		}
		seen[targetURL] = true
		m.postAlert(ctx, targetURL, bodyBytes)
	}

	if emailTarget != "" {
		m.sendEmailAlert(ctx, emailTarget, smtpAddr, smtpFrom, payload)
	}
}

func (m *Manager) postAlert(ctx context.Context, url string, bodyBytes []byte) {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "RelayGate-Notifier/1.0")

	resp, err := m.client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

func (m *Manager) sendEmailAlert(ctx context.Context, toEmail, smtpAddr, smtpFrom string, payload AlertPayload) {
	if smtpAddr == "" {
		host := strings.TrimSpace(os.Getenv("RELAYGATE_SMTP_HOST"))
		if host != "" {
			port := strings.TrimSpace(os.Getenv("RELAYGATE_SMTP_PORT"))
			if port == "" {
				port = "587"
			}
			smtpAddr = net.JoinHostPort(host, port)
		}
	}
	if smtpFrom == "" {
		smtpFrom = strings.TrimSpace(os.Getenv("RELAYGATE_SMTP_FROM"))
		if smtpFrom == "" {
			smtpFrom = "alerts@relaygate.local"
		}
	}

	subject := fmt.Sprintf("[RelayGate Alert] Incident on %s (%s)", payload.EndpointName, payload.EndpointID)
	msg := fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\nEndpoint: %s (%s)\r\nEvent ID: %s\r\nReason: %s\r\nTimestamp: %s\r\n",
		smtpFrom,
		toEmail,
		subject,
		payload.EndpointName,
		payload.EndpointID,
		payload.EventID,
		payload.Reason,
		payload.Timestamp,
	)

	if smtpAddr == "" {
		log.Printf("[NOTIFIER DEV EMAIL] To=%s Subject=%q Reason=%q", toEmail, subject, payload.Reason)
		return
	}

	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", smtpAddr)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	hostOnly, _, splitErr := net.SplitHostPort(smtpAddr)
	if splitErr != nil {
		hostOnly = smtpAddr
	}

	client, err := smtp.NewClient(conn, hostOnly)
	if err != nil {
		return
	}
	defer client.Close()

	smtpUser := strings.TrimSpace(os.Getenv("RELAYGATE_SMTP_USER"))
	smtpPass := strings.TrimSpace(os.Getenv("RELAYGATE_SMTP_PASS"))
	if smtpUser != "" && smtpPass != "" {
		auth := smtp.PlainAuth("", smtpUser, smtpPass, hostOnly)
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return
			}
		}
	}

	if err := client.Mail(smtpFrom); err != nil {
		return
	}
	if err := client.Rcpt(toEmail); err != nil {
		return
	}
	wc, err := client.Data()
	if err != nil {
		return
	}
	_, _ = wc.Write([]byte(msg))
	_ = wc.Close()
	_ = client.Quit()
}
