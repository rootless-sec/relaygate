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
	Type  string              `json:"type"` // "event_created", "event_updated", "event_replayed", "stats_updated"
	Event *model.WebhookEvent `json:"event,omitempty"`
	Data  any                 `json:"data,omitempty"`
}

// Hub manages active SSE client subscribers and real-time broadcasts
type Hub struct {
	mu      sync.RWMutex
	clients map[chan []byte]struct{}
}

// NewHub initializes an SSE broadcasting hub
func NewHub() *Hub {
	return &Hub{
		clients: make(map[chan []byte]struct{}),
	}
}

// Subscribe adds a new client channel to the hub
func (h *Hub) Subscribe() chan []byte {
	ch := make(chan []byte, 100)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes a client channel
func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
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
		msg.Event = ev
	} else if ev, ok := data.(model.WebhookEvent); ok {
		msg.Event = &ev
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
