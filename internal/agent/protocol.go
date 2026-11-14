package agent

// FrameType identifies the JSON message kind carried over the RelayGate Agent WebSocket tunnel.
type FrameType string

const (
	FrameWelcome  FrameType = "welcome"
	FrameDispatch FrameType = "dispatch"
	FrameAck      FrameType = "ack"
	FramePing     FrameType = "ping"
	FramePong     FrameType = "pong"
)

// WireFrame is the envelope exchanged between the RelayGate server hub and CLI agents.
type WireFrame struct {
	Type      FrameType         `json:"type"`
	Welcome   *WelcomePayload   `json:"welcome,omitempty"`
	Dispatch  *DispatchRequest  `json:"dispatch,omitempty"`
	Ack       *DispatchResponse `json:"ack,omitempty"`
	Timestamp int64             `json:"timestamp,omitempty"`
}

// WelcomePayload carries endpoint metadata sent immediately after an agent connects.
type WelcomePayload struct {
	EndpointID   string `json:"endpoint_id"`
	EndpointName string `json:"endpoint_name"`
	TargetURL    string `json:"target_url"`
	ServerTime   string `json:"server_time"`
}

// DispatchRequest holds raw webhook bytes and headers forwarded to a connected local agent.
type DispatchRequest struct {
	RequestID     string            `json:"request_id"`
	EventID       string            `json:"event_id"`
	EndpointID    string            `json:"endpoint_id"`
	TargetURL     string            `json:"target_url"`
	Method        string            `json:"method"`
	Headers       map[string]string `json:"headers"`
	PayloadBase64 string            `json:"payload_base64"`
	TimeoutMs     int64             `json:"timeout_ms,omitempty"`
}

// DispatchResponse reports the downstream local HTTP delivery outcome back to the server worker.
type DispatchResponse struct {
	RequestID   string `json:"request_id"`
	EventID     string `json:"event_id"`
	StatusCode  int    `json:"status_code"`
	RetryAfter  string `json:"retry_after,omitempty"`
	BodySnippet string `json:"body_snippet,omitempty"`
	DurationMs  int64  `json:"duration_ms"`
	Error       string `json:"error,omitempty"`
}
