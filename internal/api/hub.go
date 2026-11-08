package api

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/rootless-sec/relaygate/internal/model"
)

// SSEMessage represents a broadcasted event payload
type SSEMessage struct {
	Type  string `json:"type"` // "event_created", "event_updated", "event_replayed", "stats_updated"
	Event any    `json:"event,omitempty"`
	Data  any    `json:"data,omitempty"`
}

const (
	DefaultMaxTotalSSEClients = 500
	DefaultMaxSSEClientsPerIP = 10
)

// Hub manages active SSE client subscribers and real-time broadcasts
type Hub struct {
	mu           sync.RWMutex
	clients      map[chan []byte]string // channel -> client IP/key
	ipCounts     map[string]int
	maxTotal     int
	maxPerClient int
}

// NewHub initializes an SSE broadcasting hub
func NewHub() *Hub {
	return &Hub{
		clients:      make(map[chan []byte]string),
		ipCounts:     make(map[string]int),
		maxTotal:     DefaultMaxTotalSSEClients,
		maxPerClient: DefaultMaxSSEClientsPerIP,
	}
}

// SetLimits configures total and per-client connection thresholds (useful for tests and tuning)
func (h *Hub) SetLimits(maxTotal, maxPerClient int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if maxTotal > 0 {
		h.maxTotal = maxTotal
	}
	if maxPerClient > 0 {
		h.maxPerClient = maxPerClient
	}
}

// Subscribe adds a new client channel to the hub without IP limits (backward-compatible)
func (h *Hub) Subscribe() chan []byte {
	ch, _ := h.SubscribeWithLimit("anonymous")
	return ch
}

// SubscribeWithLimit adds a new client channel while enforcing total and per-client IP limits
func (h *Hub) SubscribeWithLimit(clientKey string) (chan []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clientKey == "" {
		clientKey = "unknown"
	}

	if len(h.clients) >= h.maxTotal {
		return nil, fmt.Errorf("batas total koneksi stream tercapai (%d)", h.maxTotal)
	}

	if h.ipCounts[clientKey] >= h.maxPerClient {
		return nil, fmt.Errorf("batas koneksi stream per-klien tercapai (%d)", h.maxPerClient)
	}

	ch := make(chan []byte, 100)
	h.clients[ch] = clientKey
	h.ipCounts[clientKey]++
	return ch, nil
}

// Unsubscribe removes a client channel and cleans up connection tracking
func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	if clientKey, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		if count := h.ipCounts[clientKey]; count > 1 {
			h.ipCounts[clientKey] = count - 1
		} else {
			delete(h.ipCounts, clientKey)
		}
		close(ch)
	}
	h.mu.Unlock()
}

// Broadcast sends a message to all connected clients
func (h *Hub) Broadcast(eventType string, data any) {
	msg := SSEMessage{
		Type: eventType,
	}

	if ev, ok := data.(*model.WebhookEvent); ok {
		msg.Event = formatEventResponse(ev)
	} else if ev, ok := data.(model.WebhookEvent); ok {
		msg.Event = formatEventResponse(&ev)
	} else if evResp, ok := data.(*EventResponse); ok {
		msg.Event = evResp
	} else if evResp, ok := data.(EventResponse); ok {
		msg.Event = &evResp
	} else {
		msg.Data = data
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[API-Hub] Error marshaling SSE message: %v", err)
		return
	}

	formatted := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", eventType, string(payload)))

	h.mu.RLock()
	defer h.mu.RUnlock()

	for ch := range h.clients {
		select {
		case ch <- formatted:
		default:
			// client channel buffer is full, skip to avoid blocking other clients
		}
	}
}

// ClientCount returns the number of active SSE subscribers
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
