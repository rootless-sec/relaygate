package mailer_test

import (
	"bufio"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/rootless-sec/relaygate/internal/mailer"
)

func TestMailer_GenerateOTP(t *testing.T) {
	for i := 0; i < 20; i++ {
		code, err := mailer.GenerateOTP()
		if err != nil {
			t.Fatalf("GenerateOTP failed: %v", err)
		}
		if len(code) != 6 {
			t.Fatalf("expected 6-digit code, got %s (len %d)", code, len(code))
		}
		for _, ch := range code {
			if ch < '0' || ch > '9' {
				t.Fatalf("expected only digits in code, got %s", code)
			}
		}
	}
}

func TestMailer_DevMode(t *testing.T) {
	m := mailer.NewMailer("", 587, "", "", "")
	if !m.IsDev() {
		t.Errorf("expected mailer without host to be dev mode")
	}

	err := m.SendVerificationCode("user@example.com", "Test User", "123456")
	if err != nil {
		t.Errorf("expected SendVerificationCode in dev mode to succeed, got %v", err)
	}
}

func TestMailer_NewFromEnv(t *testing.T) {
	os.Setenv("SMTP_HOST", "smtp.test.local")
	os.Setenv("SMTP_PORT", "2525")
	os.Setenv("SMTP_USER", "testuser")
	os.Setenv("SMTP_PASS", "testpass")
	os.Setenv("SMTP_FROM", "noreply@test.local")
	defer func() {
		os.Unsetenv("SMTP_HOST")
		os.Unsetenv("SMTP_PORT")
		os.Unsetenv("SMTP_USER")
		os.Unsetenv("SMTP_PASS")
		os.Unsetenv("SMTP_FROM")
	}()

	m := mailer.NewMailerFromEnv()
	if m.IsDev() {
		t.Errorf("expected mailer not to be dev mode")
	}
	if m.Host != "smtp.test.local" || m.Port != 2525 || m.User != "testuser" || m.From != "noreply@test.local" {
		t.Errorf("unexpected mailer configuration: %+v", m)
	}
}

func TestMailer_SMTPSend(t *testing.T) {
	// Start a mock SMTP server on loopback
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen on loopback: %v", err)
	}
	defer ln.Close()

	port := ln.Addr().(*net.TCPAddr).Port

	receivedChan := make(chan string, 1)

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		writer := bufio.NewWriter(conn)

		writer.WriteString("220 mock.smtp.local Service ready\r\n")
		writer.Flush()

		var receivedData strings.Builder

		inData := false
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			lineClean := strings.TrimRight(line, "\r\n")

			if inData {
				if lineClean == "." {
					inData = false
					writer.WriteString("250 OK: queued\r\n")
					writer.Flush()
				} else {
					receivedData.WriteString(line)
				}
				continue
			}

			if strings.HasPrefix(lineClean, "EHLO") || strings.HasPrefix(lineClean, "HELO") {
				writer.WriteString("250-mock.smtp.local\r\n250 HELP\r\n")
				writer.Flush()
			} else if strings.HasPrefix(lineClean, "MAIL FROM:") {
				writer.WriteString("250 2.1.0 Sender OK\r\n")
				writer.Flush()
			} else if strings.HasPrefix(lineClean, "RCPT TO:") {
				writer.WriteString("250 2.1.5 Recipient OK\r\n")
				writer.Flush()
			} else if lineClean == "DATA" {
				inData = true
				writer.WriteString("354 Start mail input; end with <CRLF>.<CRLF>\r\n")
				writer.Flush()
			} else if lineClean == "QUIT" {
				writer.WriteString("221 2.0.0 Service closing transmission channel\r\n")
				writer.Flush()
				break
			} else {
				writer.WriteString("502 Command not implemented\r\n")
				writer.Flush()
			}
		}

		receivedChan <- receivedData.String()
	}()

	m := mailer.NewMailer("127.0.0.1", port, "", "", "noreply@relaygate.local")
	err = m.SendVerificationCode("recipient@example.com", "John Doe", "987654")
	if err != nil {
		t.Fatalf("SendVerificationCode failed with mock SMTP: %v", err)
	}

	content := <-receivedChan
	if !strings.Contains(content, "987654") {
		t.Errorf("expected received email to contain code 987654, got: %s", content)
	}
	if !strings.Contains(content, "John Doe") {
		t.Errorf("expected received email to contain recipient name John Doe, got: %s", content)
	}
}
