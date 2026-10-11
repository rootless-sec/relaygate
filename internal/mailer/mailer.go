package mailer

import (
	"crypto/rand"
	"crypto/tls"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// Mailer handles sending transactional emails via SMTP or dev mock
type Mailer struct {
	Host string
	Port int
	User string
	Pass string
	From string
}

// NewMailer creates a new Mailer instance with explicit parameters
func NewMailer(host string, port int, user, pass, from string) *Mailer {
	if port <= 0 {
		port = 587
	}
	return &Mailer{
		Host: strings.TrimSpace(host),
		Port: port,
		User: strings.TrimSpace(user),
		Pass: pass,
		From: strings.TrimSpace(from),
	}
}

// NewMailerFromEnv initializes Mailer using standard SMTP environment variables
func NewMailerFromEnv() *Mailer {
	host := os.Getenv("SMTP_HOST")
	portStr := os.Getenv("SMTP_PORT")
	port := 587
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
			port = p
		}
	}
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := os.Getenv("SMTP_FROM")

	return NewMailer(host, port, user, pass, from)
}

// IsDev returns true if SMTP is not configured
func (m *Mailer) IsDev() bool {
	return m == nil || m.Host == ""
}

// GenerateOTP produces a secure 6-digit numeric verification code
func GenerateOTP() (string, error) {
	maxVal := big.NewInt(1000000)
	n, err := rand.Int(rand.Reader, maxVal)
	if err != nil {
		return "", fmt.Errorf("failed to generate secure random code: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// SendVerificationCode sends the 6-digit OTP code to the recipient email
func (m *Mailer) SendVerificationCode(toEmail, toName, code string) error {
	toEmail = strings.TrimSpace(toEmail)
	if toName == "" {
		toName = "Pengguna RelayGate"
	}

	if m.IsDev() {
		log.Printf("[RelayGate] [EMAIL-DEV] Verification code for %s <%s>: %s (valid for 15 minutes)", toName, toEmail, code)
		return nil
	}

	from := m.From
	if from == "" {
		from = m.User
	}
	if from == "" {
		from = "no-reply@relaygate.local"
	}

	subject := fmt.Sprintf("[RelayGate] Kode Verifikasi Pendaftaran: %s", code)
	body := fmt.Sprintf(
		"Halo %s,\r\n\r\n"+
			"Berikut adalah 6-digit kode verifikasi Anda untuk pendaftaran akun RelayGate:\r\n\r\n"+
			"    %s\r\n\r\n"+
			"Kode ini berlaku selama 15 menit. Jangan bagikan kode ini kepada siapapun demi keamanan akun Anda.\r\n\r\n"+
			"Jika Anda tidak merasa mendaftar di RelayGate, silakan abaikan email ini.\r\n\r\n"+
			"Salam,\r\n"+
			"Tim RelayGate\r\n",
		toName, code,
	)

	msg := []byte(fmt.Sprintf(
		"From: %s\r\n"+
			"To: %s\r\n"+
			"Subject: %s\r\n"+
			"MIME-Version: 1.0\r\n"+
			"Content-Type: text/plain; charset=UTF-8\r\n"+
			"\r\n%s",
		from, toEmail, subject, body,
	))

	addr := fmt.Sprintf("%s:%d", m.Host, m.Port)

	var auth smtp.Auth
	if m.User != "" && m.Pass != "" {
		auth = smtp.PlainAuth("", m.User, m.Pass, m.Host)
	}

	// Implicit TLS connection (standard for port 465)
	if m.Port == 465 {
		dialer := &net.Dialer{Timeout: 15 * time.Second}
		tlsConn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: m.Host,
		})
		if err != nil {
			return fmt.Errorf("tls smtp connection to %s failed: %w", addr, err)
		}
		defer tlsConn.Close()

		c, err := smtp.NewClient(tlsConn, m.Host)
		if err != nil {
			return fmt.Errorf("smtp client creation failed: %w", err)
		}
		defer c.Close()

		if auth != nil {
			if err = c.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth failed: %w", err)
			}
		}
		if err = c.Mail(from); err != nil {
			return fmt.Errorf("smtp MAIL FROM failed: %w", err)
		}
		if err = c.Rcpt(toEmail); err != nil {
			return fmt.Errorf("smtp RCPT TO failed: %w", err)
		}
		w, err := c.Data()
		if err != nil {
			return fmt.Errorf("smtp DATA failed: %w", err)
		}
		if _, err = w.Write(msg); err != nil {
			return fmt.Errorf("smtp write message failed: %w", err)
		}
		if err = w.Close(); err != nil {
			return fmt.Errorf("smtp close data failed: %w", err)
		}
		return c.Quit()
	}

	// Standard STARTTLS or plain connection (port 587, 25, 2525)
	return smtp.SendMail(addr, auth, from, []string{toEmail}, msg)
}
