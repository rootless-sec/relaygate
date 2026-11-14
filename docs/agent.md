# RelayGate CLI Agent (`relaygate-agent`)

`relaygate-agent` is RelayGate's built-in outbound tunnel client for bridging a hosted or shared RelayGate server to downstream consumers running on `localhost`, private VPC subnets, or internal office and staging networks behind NAT and firewalls.

---

## Purpose & Why Use It

When teams develop locally or run internal microservices behind private networks, webhooks from Stripe, Midtrans, GitHub, Shopify, Xendit, DOKU, or Flip usually cannot reach those targets without opening inbound firewall ports, configuring router port forwarding, or introducing third-party tunneling proxies (such as ngrok).

`relaygate-agent` eliminates those tradeoffs while keeping every gateway guarantee intact:

1. **Zero Inbound Network Exposure**: The agent initiates an **outbound** RFC 6455 WebSocket connection (`GET /api/v1/agent/connect`) authenticated with a per-endpoint `agt_...` token. Internal services do not need public IPs or inbound firewall rules.
2. **Full Gateway Guarantees Preserved**: Even over a local tunnel, every webhook still goes through RelayGate's server-side signature verification, idempotency deduplication (`idempotency_keys`), optional canonical envelope wrapping, `delivery_logs` latency/status telemetry, per-destination circuit breakers, and single/bulk DLQ replay.
3. **Live Dashboard Awareness**: Connected endpoints automatically show an `Agent Online` pill in the **Endpoints** view (falling back to `Direct HTTP` when offline), with live state synchronization over SSE (`agent_status`).
4. **Pure Go & Zero External Dependencies**: Built strictly on the Go standard library with bounded exponential-backoff reconnection (`100ms` to `5s`), buffered `pendingAcks` flushing on reconnect, HTTP `3xx` redirect blocking (`http.ErrUseLastResponse`), and hop-by-hop header filtering.

---

## Running `relaygate-agent`

You can run the agent either as a dedicated standalone binary or directly via the embedded mode built into the main `relaygate` binary.

### 1. Standalone Binary

```bash
go build -o relaygate-agent ./cmd/relaygate-agent
./relaygate-agent \
  -server http://127.0.0.1:8080 \
  -token agt_your_endpoint_token \
  -forward http://127.0.0.1:3000/webhooks
```

### 2. Embedded Mode (`relaygate -agent`)

```bash
./relaygate -agent \
  -server http://127.0.0.1:8080 \
  -token agt_your_endpoint_token \
  -forward http://127.0.0.1:3000/webhooks
```

---

## Dashboard Workflow (`Endpoints` View)

1. Open **Manage -> Endpoints** in the RelayGate dashboard and click `>_ CLI` on the target endpoint row.
2. Copy the pre-filled command containing your `agent_token` (`agt_...`), or set `RELAYGATE_SERVER_URL`, `RELAYGATE_AGENT_TOKEN`, and `RELAYGATE_AGENT_FORWARD`.
3. Once started, `relaygate-agent` prints `Tunnel ONLINE` and the dashboard switches the endpoint's **Relay Agent** badge from `Direct HTTP` to `Agent Online`.
4. To revoke access or re-issue credentials, click **Rotate Token** inside the `>_ CLI` modal (`POST /api/v1/endpoints/{id}/agent-token`), which immediately invalidates previous tokens and closes any active tunnel session for that endpoint.

---

## Further Reference

* **Flags & Environment Variables**: See [Configuration & Deployment](configuration.md#relaygate-agent-cli-flags-local-outbound-forwarder).
* **WebSocket Frames, Security Hardening & ACK Recovery**: See [Architecture & Internals](architecture.md#5-relaygate-cli-agent-tunnel-internalagent).
* **Control-Plane Routes**: See [API Reference](api.md#relaygate-cli-agent-tunnel--token-endpoints).
