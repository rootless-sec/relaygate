package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rootless-sec/relaygate/internal/agent"
)

func main() {
	defaultServer := envOrDefault("RELAYGATE_SERVER_URL", "http://127.0.0.1:8080")
	defaultToken := envOrDefault("RELAYGATE_AGENT_TOKEN", "")
	defaultForward := envOrDefault("RELAYGATE_AGENT_FORWARD", "")

	serverURL := flag.String("server", defaultServer, "RelayGate server base URL")
	token := flag.String("token", defaultToken, "Endpoint agent token (agt_...)")
	forwardURL := flag.String("forward", defaultForward, "Optional local target URL override (e.g. http://127.0.0.1:3000/webhook)")
	timeout := flag.Duration("timeout", 15*time.Second, "Timeout per local webhook POST attempt")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agent.RunCLI(ctx, agent.ClientConfig{
		ServerURL:  *serverURL,
		Token:      *token,
		ForwardURL: *forwardURL,
		Timeout:    *timeout,
	}); err != nil && err != context.Canceled {
		log.Fatalf("[RelayGate Agent] Fatal error: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
