package model

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// CanonicalEnvelope represents the normalized RelayGate webhook payload structure.
type CanonicalEnvelope struct {
	EventType  string `json:"event_type"`
	ExternalID string `json:"external_id"`
	Amount     any    `json:"amount"`
	Currency   string `json:"currency"`
	RawPayload any    `json:"raw_payload"`
}

// LookupHeader Case-insensitively retrieves a header value from a map.
func LookupHeader(headers map[string]string, key string) string {
	if headers == nil {
		return ""
	}
	if v, ok := headers[key]; ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	for k, v := range headers {
		if strings.EqualFold(k, key) && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ExtractIdempotencyKey extracts a provider-aware upstream delivery or transaction key.
// Returns empty string if no idempotency identifier is present in headers or payload.
func ExtractIdempotencyKey(provider ProviderType, headers map[string]string, payload []byte) string {
	// 1. Check explicit delivery/idempotency headers first
	headerKeys := []string{
		"X-GitHub-Delivery",
		"X-Shopify-Webhook-Id",
		"Request-Id",
		"X-Request-Id",
		"Idempotency-Key",
		"Webhook-Id",
	}
	for _, hk := range headerKeys {
		if val := LookupHeader(headers, hk); val != "" {
			return val
		}
	}

	jsonBytes := extractJSONBytes(provider, headers, payload)
	if len(jsonBytes) == 0 {
		return ""
	}

	var parsed map[string]any
	if err := json.Unmarshal(jsonBytes, &parsed); err != nil {
		return ""
	}

	// 2. Provider-specific composite keys (Midtrans)
	orderID := asString(parsed["order_id"])
	statusCode := asString(parsed["status_code"])
	txID := asString(parsed["transaction_id"])
	txStatus := asString(parsed["transaction_status"])
	if orderID != "" && statusCode != "" {
		return fmt.Sprintf("midtrans:%s:%s:%s", orderID, statusCode, txStatus)
	}
	if txID != "" && txStatus != "" {
		return fmt.Sprintf("midtrans:%s:%s", txID, txStatus)
	}

	// 3. DOKU nested invoice_number fallback
	if orderObj, ok := parsed["order"].(map[string]any); ok {
		if inv := asString(orderObj["invoice_number"]); inv != "" {
			txStat := ""
			if txObj, ok := parsed["transaction"].(map[string]any); ok {
				txStat = asString(txObj["status"])
			}
			if txStat != "" {
				return fmt.Sprintf("doku:%s:%s", inv, txStat)
			}
			return inv
		}
	}

	// 4. Standard top-level "id" field (Stripe, Xendit, Flip, Generic, etc.)
	if idVal := asString(parsed["id"]); idVal != "" {
		return idVal
	}
	if extID := asString(parsed["external_id"]); extID != "" {
		return extID
	}

	return ""
}

// BuildCanonicalEnvelope constructs a normalized CanonicalEnvelope from any provider payload.
func BuildCanonicalEnvelope(provider ProviderType, headers map[string]string, payload []byte, fallbackID string) CanonicalEnvelope {
	env := CanonicalEnvelope{
		EventType:  "webhook.received",
		ExternalID: fallbackID,
		Amount:     float64(0),
		Currency:   "",
	}

	if ghEvent := LookupHeader(headers, "X-GitHub-Event"); ghEvent != "" {
		env.EventType = ghEvent
	} else if shopTopic := LookupHeader(headers, "X-Shopify-Topic"); shopTopic != "" {
		env.EventType = shopTopic
	}

	for _, hk := range []string{"X-GitHub-Delivery", "X-Shopify-Webhook-Id", "Request-Id", "X-Request-Id"} {
		if hv := LookupHeader(headers, hk); hv != "" {
			env.ExternalID = hv
			break
		}
	}

	jsonBytes := extractJSONBytes(provider, headers, payload)
	if len(jsonBytes) > 0 {
		var parsed map[string]any
		if err := json.Unmarshal(jsonBytes, &parsed); err == nil && parsed != nil {
			env.RawPayload = json.RawMessage(jsonBytes)

			// Extract ExternalID
			if idStr := firstNonEmpty(
				asString(parsed["id"]),
				asString(parsed["external_id"]),
				asString(parsed["transaction_id"]),
				asString(parsed["order_id"]),
				nestedString(parsed, "order", "invoice_number"),
				nestedString(parsed, "data", "id"),
			); idStr != "" {
				env.ExternalID = idStr
			}

			// Extract EventType
			if evType := firstNonEmpty(
				asString(parsed["type"]),
				asString(parsed["event"]),
				asString(parsed["event_type"]),
				asString(parsed["transaction_status"]),
				asString(parsed["status"]),
				nestedString(parsed, "transaction", "status"),
				asString(parsed["action"]),
			); evType != "" {
				env.EventType = evType
			}

			// Extract Amount
			if amt, ok := firstAmount(
				parsed["amount"],
				parsed["amount_total"],
				parsed["gross_amount"],
				nestedValue(parsed, "order", "amount"),
				nestedValue(parsed, "data", "amount"),
				nestedValue(parsed, "data", "object", "amount"),
			); ok {
				env.Amount = amt
			}

			// Extract Currency
			if curr := firstNonEmpty(
				asString(parsed["currency"]),
				nestedString(parsed, "order", "currency"),
				nestedString(parsed, "data", "currency"),
				nestedString(parsed, "data", "object", "currency"),
			); curr != "" {
				env.Currency = curr
			}

			return env
		}
	}

	// Non-JSON fallback: preserve raw string payload without crashing
	env.RawPayload = string(payload)
	return env
}

// SignStandardWebhook computes a Standard Webhooks signature header ("v1,<base64_hmac_sha256>").
// The signed content is "<msgID>.<unixTimestamp>.<rawBody>".
func SignStandardWebhook(msgID string, timestamp time.Time, body []byte, secret string) (string, string) {
	tsStr := strconv.FormatInt(timestamp.UTC().Unix(), 10)
	toSign := fmt.Sprintf("%s.%s.%s", msgID, tsStr, string(body))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(toSign))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return tsStr, "v1," + sig
}

func extractJSONBytes(provider ProviderType, headers map[string]string, payload []byte) []byte {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		return []byte(trimmed)
	}
	ct := strings.ToLower(LookupHeader(headers, "Content-Type"))
	if provider == ProviderFlip || strings.Contains(ct, "application/x-www-form-urlencoded") || strings.Contains(trimmed, "data=") {
		if form, err := url.ParseQuery(trimmed); err == nil {
			if dataStr := strings.TrimSpace(form.Get("data")); dataStr != "" {
				return []byte(dataStr)
			}
		}
	}
	return nil
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return strings.TrimSpace(val)
	case float64:
		if val == float64(int64(val)) {
			return strconv.FormatInt(int64(val), 10)
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case json.Number:
		return val.String()
	default:
		return ""
	}
}

func nestedValue(m map[string]any, keys ...string) any {
	curr := any(m)
	for _, k := range keys {
		obj, ok := curr.(map[string]any)
		if !ok {
			return nil
		}
		curr = obj[k]
	}
	return curr
}

func nestedString(m map[string]any, keys ...string) string {
	return asString(nestedValue(m, keys...))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func firstAmount(vals ...any) (any, bool) {
	for _, v := range vals {
		if v == nil {
			continue
		}
		switch val := v.(type) {
		case float64:
			return val, true
		case int:
			return val, true
		case int64:
			return val, true
		case json.Number:
			if f, err := val.Float64(); err == nil {
				return f, true
			}
		case string:
			s := strings.TrimSpace(val)
			if s != "" {
				if f, err := strconv.ParseFloat(s, 64); err == nil {
					return f, true
				}
			}
		}
	}
	return float64(0), false
}
