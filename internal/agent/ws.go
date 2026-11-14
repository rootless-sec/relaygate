package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	wsMagicGUID      = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	opContinuation   = 0x0
	opText           = 0x1
	opBinary         = 0x2
	opClose          = 0x8
	opPing           = 0x9
	opPong           = 0xA
	maxWSFrameSize   = 16 * 1024 * 1024
	wsHandshakeLimit = 10 * time.Second
)

// WSConn implements pure-Go RFC 6455 WebSocket framing over a TCP/TLS connection.
type WSConn struct {
	conn            net.Conn
	br              *bufio.Reader
	bw              *bufio.Writer
	isClient        bool
	readIdleTimeout time.Duration
	writeMu         sync.Mutex
	closeOnce       sync.Once
}

func computeWebSocketAccept(key string) string {
	h := sha1.New()
	_, _ = h.Write([]byte(strings.TrimSpace(key) + wsMagicGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerContainsToken(values []string, target string) bool {
	for _, val := range values {
		for _, part := range strings.Split(val, ",") {
			if strings.EqualFold(strings.TrimSpace(part), target) {
				return true
			}
		}
	}
	return false
}

// UpgradeHTTP hijacks an HTTP/1.1 request and completes the RFC 6455 WebSocket handshake.
func UpgradeHTTP(w http.ResponseWriter, r *http.Request) (*WSConn, error) {
	if r.Method != http.MethodGet {
		return nil, fmt.Errorf("websocket upgrade requires GET method")
	}
	if !headerContainsToken(r.Header.Values("Connection"), "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return nil, fmt.Errorf("missing websocket upgrade headers")
	}
	wsKey := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if wsKey == "" {
		return nil, fmt.Errorf("missing Sec-WebSocket-Key header")
	}

	// Clear net/http read/write deadlines before hijacking so server WriteTimeout never aborts idle tunnels.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, fmt.Errorf("response writer does not implement http.Hijacker")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("hijack failed: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})

	accept := computeWebSocketAccept(wsKey)
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"

	if _, err := rw.Writer.WriteString(response); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed writing handshake response: %w", err)
	}
	if err := rw.Writer.Flush(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed flushing handshake response: %w", err)
	}

	return &WSConn{
		conn:     conn,
		br:       rw.Reader,
		bw:       rw.Writer,
		isClient: false,
	}, nil
}

// DialWS opens a client RFC 6455 WebSocket connection to a ws://, wss://, http://, or https:// URL.
func DialWS(ctx context.Context, rawURL string, headers map[string]string) (*WSConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid websocket url: %w", err)
	}

	useTLS := false
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
		useTLS = false
	case "https", "wss":
		useTLS = true
	default:
		return nil, fmt.Errorf("unsupported url scheme %q", u.Scheme)
	}

	host := u.Host
	if host == "" {
		return nil, fmt.Errorf("missing host in websocket url")
	}
	dialAddr := host
	if !strings.Contains(host, ":") || (strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]")) {
		if useTLS {
			dialAddr = host + ":443"
		} else {
			dialAddr = host + ":80"
		}
	}

	dialer := &net.Dialer{Timeout: wsHandshakeLimit}
	var conn net.Conn
	if useTLS {
		tlsDialer := &tls.Dialer{NetDialer: dialer}
		conn, err = tlsDialer.DialContext(ctx, "tcp", dialAddr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", dialAddr)
	}
	if err != nil {
		return nil, fmt.Errorf("websocket dial failed: %w", err)
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed generating websocket key: %w", err)
	}
	wsKey := base64.StdEncoding.EncodeToString(keyBytes)

	reqURI := u.RequestURI()
	if reqURI == "" {
		reqURI = "/"
	}

	var sb strings.Builder
	sb.WriteString("GET ")
	sb.WriteString(reqURI)
	sb.WriteString(" HTTP/1.1\r\n")
	sb.WriteString("Host: ")
	sb.WriteString(host)
	sb.WriteString("\r\nUpgrade: websocket\r\n")
	sb.WriteString("Connection: Upgrade\r\n")
	sb.WriteString("Sec-WebSocket-Key: ")
	sb.WriteString(wsKey)
	sb.WriteString("\r\nSec-WebSocket-Version: 13\r\n")
	for k, v := range headers {
		// Strip CR/LF so header values cannot inject arbitrary HTTP headers.
		cleanK := strings.NewReplacer("\r", "", "\n", "").Replace(k)
		cleanV := strings.NewReplacer("\r", "", "\n", "").Replace(v)
		sb.WriteString(cleanK)
		sb.WriteString(": ")
		sb.WriteString(cleanV)
		sb.WriteString("\r\n")
	}
	sb.WriteString("\r\n")

	_ = conn.SetDeadline(time.Now().Add(wsHandshakeLimit))
	if _, err := io.WriteString(conn, sb.String()); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed sending websocket handshake: %w", err)
	}

	br := bufio.NewReader(conn)
	dummyReq, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	resp, err := http.ReadResponse(br, dummyReq)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed reading handshake response: %w", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket handshake rejected with HTTP %d", resp.StatusCode)
	}
	expectedAccept := computeWebSocketAccept(wsKey)
	if strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept")) != expectedAccept {
		_ = conn.Close()
		return nil, fmt.Errorf("invalid Sec-WebSocket-Accept header")
	}

	_ = conn.SetDeadline(time.Time{})

	return &WSConn{
		conn:     conn,
		br:       br,
		bw:       bufio.NewWriter(conn),
		isClient: true,
	}, nil
}

// SetReadDeadline sets the underlying network connection read deadline.
func (c *WSConn) SetReadDeadline(t time.Time) error {
	return c.conn.SetReadDeadline(t)
}

// SetReadIdleTimeout configures automatic read deadline renewal on every incoming frame.
func (c *WSConn) SetReadIdleTimeout(d time.Duration) {
	c.readIdleTimeout = d
}

// Close closes the underlying WebSocket connection once.
func (c *WSConn) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		closeErr = c.conn.Close()
	})
	return closeErr
}

// WriteText writes an RFC 6455 text frame in a thread-safe manner.
func (c *WSConn) WriteText(payload []byte) error {
	return c.writeFrame(opText, payload)
}

// WritePing writes an RFC 6455 ping control frame.
func (c *WSConn) WritePing(payload []byte) error {
	if len(payload) > 125 {
		payload = payload[:125]
	}
	return c.writeFrame(opPing, payload)
}

// WriteClose sends an RFC 6455 close frame and closes the connection.
func (c *WSConn) WriteClose(code uint16, reason string) error {
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], code)
	copy(payload[2:], reason)
	if len(payload) > 125 {
		payload = payload[:125]
	}
	_ = c.writeFrame(opClose, payload)
	return c.Close()
}

func (c *WSConn) writeFrame(opcode byte, payload []byte) error {
	if len(payload) > maxWSFrameSize {
		return fmt.Errorf("websocket payload too large: %d bytes", len(payload))
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	header := make([]byte, 0, 14)
	header = append(header, 0x80|opcode) // FIN=1, RSV=0

	maskBit := byte(0)
	if c.isClient {
		maskBit = 0x80
	}

	pLen := len(payload)
	switch {
	case pLen < 126:
		header = append(header, maskBit|byte(pLen))
	case pLen <= 0xFFFF:
		header = append(header, maskBit|126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(pLen))
		header = append(header, ext[:]...)
	default:
		header = append(header, maskBit|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(pLen))
		header = append(header, ext[:]...)
	}

	var maskKey [4]byte
	if c.isClient {
		if _, err := rand.Read(maskKey[:]); err != nil {
			return fmt.Errorf("failed generating mask key: %w", err)
		}
		header = append(header, maskKey[:]...)
	}

	if _, err := c.bw.Write(header); err != nil {
		return err
	}

	if pLen > 0 {
		if c.isClient {
			masked := make([]byte, pLen)
			for i := 0; i < pLen; i++ {
				masked[i] = payload[i] ^ maskKey[i%4]
			}
			if _, err := c.bw.Write(masked); err != nil {
				return err
			}
		} else {
			if _, err := c.bw.Write(payload); err != nil {
				return err
			}
		}
	}

	return c.bw.Flush()
}

// ReadMessage reads the next complete text or binary message, answering pings automatically.
func (c *WSConn) ReadMessage() (byte, []byte, error) {
	var msgOpcode byte
	var fragments []byte

	for {
		fin, opcode, frameData, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}

		switch opcode {
		case opPing:
			_ = c.writeFrame(opPong, frameData)
			continue
		case opPong:
			continue
		case opClose:
			_ = c.writeFrame(opClose, nil)
			return opClose, nil, io.EOF
		case opText, opBinary:
			if fin {
				return opcode, frameData, nil
			}
			msgOpcode = opcode
			fragments = append(fragments[:0], frameData...)
		case opContinuation:
			if len(fragments)+len(frameData) > maxWSFrameSize {
				return 0, nil, errors.New("fragmented websocket message exceeds max size")
			}
			fragments = append(fragments, frameData...)
			if fin {
				return msgOpcode, fragments, nil
			}
		default:
			return 0, nil, fmt.Errorf("unsupported websocket opcode: 0x%x", opcode)
		}
	}
}

func (c *WSConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	if c.readIdleTimeout > 0 {
		_ = c.conn.SetReadDeadline(time.Now().Add(c.readIdleTimeout))
	}
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}

	fin = (hdr[0] & 0x80) != 0
	opcode = hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	pLen := uint64(hdr[1] & 0x7F)

	switch pLen {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		pLen = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		pLen = binary.BigEndian.Uint64(ext[:])
	}

	if pLen > maxWSFrameSize {
		return false, 0, nil, fmt.Errorf("websocket frame too large: %d bytes", pLen)
	}

	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}

	if pLen > 0 {
		payload = make([]byte, pLen)
		if _, err = io.ReadFull(c.br, payload); err != nil {
			return false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i%4]
			}
		}
	}

	return fin, opcode, payload, nil
}
