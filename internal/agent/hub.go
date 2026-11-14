package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/rootless-sec/relaygate/internal/storage"
)

// ErrNoConnectedAgent indicates no live relaygate-agent tunnel is registered for the endpoint.
var ErrNoConnectedAgent = errors.New("no connected relaygate-agent session for endpoint")

const (
	defaultPingInterval = 15 * time.Second
	defaultPongWait     = 45 * time.Second
)

type agentSession struct {
	id         string
	endpointID string
	conn       *WSConn
	done       chan struct{}
	closeOnce  sync.Once
}

func (s *agentSession) closeSession() {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.conn.Close()
	})
}

// Hub maintains active outbound WebSocket tunnel sessions keyed by endpoint ID.
type Hub struct {
	repo         storage.Repository
	onStatus     func(endpointID string, connected bool)
	pingInterval time.Duration
	pongWait     time.Duration

	mu       sync.RWMutex
	sessions map[string][]*agentSession
	pending  map[string]chan *DispatchResponse
	rrIndex  atomic.Uint64
}

// NewHub creates an agent tunnel hub backed by endpoint token lookup in repo.
func NewHub(repo storage.Repository, onStatus func(endpointID string, connected bool)) *Hub {
	return &Hub{
		repo:         repo,
		onStatus:     onStatus,
		pingInterval: defaultPingInterval,
		pongWait:     defaultPongWait,
		sessions:     make(map[string][]*agentSession),
		pending:      make(map[string]chan *DispatchResponse),
	}
}

// SetKeepalive configures ping/pong heartbeat intervals (primarily for tests).
func (h *Hub) SetKeepalive(pingInterval, pongWait time.Duration) {
	if pingInterval > 0 {
		h.pingInterval = pingInterval
	}
	if pongWait > 0 {
		h.pongWait = pongWait
	}
}

// HasAgent reports whether at least one live relaygate-agent tunnel is connected for endpointID.
func (h *Hub) HasAgent(endpointID string) bool {
	if h == nil || endpointID == "" {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions[endpointID]) > 0
}

// ConnectedCounts returns a snapshot map of endpointID to active session count.
func (h *Hub) ConnectedCounts() map[string]int {
	out := make(map[string]int)
	if h == nil {
		return out
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for epID, list := range h.sessions {
		if len(list) > 0 {
			out[epID] = len(list)
		}
	}
	return out
}

// DisconnectEndpoint closes all active agent sessions for endpointID (e.g. after token rotation).
func (h *Hub) DisconnectEndpoint(endpointID string) {
	if h == nil || endpointID == "" {
		return
	}
	h.mu.Lock()
	list := append([]*agentSession(nil), h.sessions[endpointID]...)
	delete(h.sessions, endpointID)
	h.mu.Unlock()

	for _, sess := range list {
		_ = sess.conn.WriteClose(1008, "agent token rotated or endpoint disabled")
		sess.closeSession()
	}
	if len(list) > 0 {
		h.notifyStatus(endpointID, false)
	}
}

// Dispatch sends a raw webhook payload over an active tunnel session and awaits the agent ACK.
func (h *Hub) Dispatch(ctx context.Context, endpointID string, req DispatchRequest) (*DispatchResponse, error) {
	if h == nil {
		return nil, ErrNoConnectedAgent
	}
	if req.RequestID == "" {
		req.RequestID = uuid.NewString()
	}

	sess := h.pickSession(endpointID)
	if sess == nil {
		return nil, ErrNoConnectedAgent
	}

	respCh := make(chan *DispatchResponse, 1)
	h.mu.Lock()
	h.pending[req.RequestID] = respCh
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.pending, req.RequestID)
		h.mu.Unlock()
	}()

	frameBytes, err := json.Marshal(WireFrame{
		Type:     FrameDispatch,
		Dispatch: &req,
	})
	if err != nil {
		return nil, err
	}

	// If the chosen session's socket is dead, evict it and retry once on another live session.
	if err := sess.conn.WriteText(frameBytes); err != nil {
		h.removeSession(sess)
		sess = h.pickSession(endpointID)
		if sess == nil {
			return nil, ErrNoConnectedAgent
		}
		if err2 := sess.conn.WriteText(frameBytes); err2 != nil {
			h.removeSession(sess)
			return nil, err2
		}
	}

	select {
	case resp := <-respCh:
		return resp, nil
	case <-sess.done:
		select {
		case resp := <-respCh:
			return resp, nil
		default:
			return nil, errors.New("relaygate-agent disconnected during dispatch")
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (h *Hub) pickSession(endpointID string) *agentSession {
	h.mu.RLock()
	defer h.mu.RUnlock()
	list := h.sessions[endpointID]
	if len(list) == 0 {
		return nil
	}
	idx := int(h.rrIndex.Add(1)-1) % len(list)
	return list[idx]
}

func (h *Hub) registerSession(sess *agentSession) {
	h.mu.Lock()
	wasEmpty := len(h.sessions[sess.endpointID]) == 0
	h.sessions[sess.endpointID] = append(h.sessions[sess.endpointID], sess)
	h.mu.Unlock()

	if wasEmpty {
		h.notifyStatus(sess.endpointID, true)
	}
}

func (h *Hub) removeSession(sess *agentSession) {
	h.mu.Lock()
	list := h.sessions[sess.endpointID]
	removed := false
	for i, s := range list {
		if s.id == sess.id {
			list = append(list[:i], list[i+1:]...)
			removed = true
			break
		}
	}
	nowEmpty := false
	if len(list) == 0 {
		delete(h.sessions, sess.endpointID)
		nowEmpty = removed
	} else {
		h.sessions[sess.endpointID] = list
	}
	h.mu.Unlock()

	sess.closeSession()
	if nowEmpty {
		h.notifyStatus(sess.endpointID, false)
	}
}

func (h *Hub) notifyStatus(endpointID string, connected bool) {
	if h.onStatus == nil {
		return
	}
	go h.onStatus(endpointID, connected)
}

func extractAgentToken(r *http.Request) string {
	if tok := strings.TrimSpace(r.Header.Get("X-RelayGate-Agent-Token")); tok != "" {
		return tok
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:])
	}
	return strings.TrimSpace(r.URL.Query().Get("agent_token"))
}

// ServeConnect authenticates an agent token and upgrades the request into a persistent tunnel session.
func (h *Hub) ServeConnect(w http.ResponseWriter, r *http.Request) {
	token := extractAgentToken(r)
	if token == "" || h.repo == nil {
		http.Error(w, `{"error":"agent token required"}`, http.StatusUnauthorized)
		return
	}

	ep, err := h.repo.GetEndpointByAgentToken(r.Context(), token)
	if err != nil || ep == nil {
		http.Error(w, `{"error":"invalid agent token"}`, http.StatusUnauthorized)
		return
	}

	conn, err := UpgradeHTTP(w, r)
	if err != nil {
		http.Error(w, `{"error":"websocket upgrade failed"}`, http.StatusBadRequest)
		return
	}

	sess := &agentSession{
		id:         uuid.NewString(),
		endpointID: ep.ID,
		conn:       conn,
		done:       make(chan struct{}),
	}

	h.registerSession(sess)
	defer h.removeSession(sess)

	welcomeBytes, _ := json.Marshal(WireFrame{
		Type: FrameWelcome,
		Welcome: &WelcomePayload{
			EndpointID:   ep.ID,
			EndpointName: ep.Name,
			TargetURL:    ep.TargetURL,
			ServerTime:   time.Now().UTC().Format(time.RFC3339),
		},
	})
	if err := conn.WriteText(welcomeBytes); err != nil {
		return
	}

	// Background WebSocket ping heartbeat keeps NAT/proxies alive and detects silent TCP drops.
	go func() {
		ticker := time.NewTicker(h.pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sess.done:
				return
			case <-ticker.C:
				if err := conn.WritePing([]byte("keepalive")); err != nil {
					sess.closeSession()
					return
				}
			}
		}
	}()

	conn.SetReadIdleTimeout(h.pongWait)
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var frame WireFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			continue
		}

		switch frame.Type {
		case FrameAck:
			if frame.Ack != nil && frame.Ack.RequestID != "" {
				h.mu.RLock()
				ch, ok := h.pending[frame.Ack.RequestID]
				h.mu.RUnlock()
				if ok {
					select {
					case ch <- frame.Ack:
					default:
					}
				}
			}
		case FramePing:
			pongBytes, _ := json.Marshal(WireFrame{
				Type:      FramePong,
				Timestamp: frame.Timestamp,
			})
			_ = conn.WriteText(pongBytes)
		}
	}
}
