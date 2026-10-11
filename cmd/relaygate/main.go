package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/rootless-sec/relaygate/internal/api"
	"github.com/rootless-sec/relaygate/internal/ingest"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
	"github.com/rootless-sec/relaygate/ui"
)

func main() {
	// Parse CLI flags and environment variables
	defaultAddr := getEnv("RELAYGATE_ADDR", ":8080")
	if port := os.Getenv("PORT"); port != "" && defaultAddr == ":8080" {
		defaultAddr = ":" + port
	}
	defaultDB := getEnv("RELAYGATE_DB_PATH", "./data/relaygate.db")
	defaultWorkers := getEnvInt("RELAYGATE_WORKERS", 10)

	addr := flag.String("addr", defaultAddr, "HTTP server listening address")
	dbPath := flag.String("db", defaultDB, "SQLite database file path")
	workers := flag.Int("workers", defaultWorkers, "Number of concurrent dispatch workers")
	flag.Parse()

	log.Printf("[RelayGate] Starting core engine...")
	log.Printf("[RelayGate] Database path: %s", *dbPath)
	log.Printf("[RelayGate] Dispatch workers: %d", *workers)

	// Initialize SQLite WAL repository
	repo, err := storage.Open(*dbPath)
	if err != nil {
		log.Fatalf("[RelayGate] Fatal storage initialization error: %v", err)
	}
	defer func() {
		if err := repo.Close(); err != nil {
			log.Printf("[RelayGate] Error closing database: %v", err)
		} else {
			log.Printf("[RelayGate] Storage closed cleanly.")
		}
	}()

	// Initialize cryptographic verifier engine
	v := verifier.NewEngine()

	// Initialize worker pool
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = *workers
	pool := worker.NewPool(repo, v, workerCfg)
	pool.Start()
	log.Printf("[RelayGate] Worker pool started with %d workers.", *workers)
	defer func() {
		log.Printf("[RelayGate] Stopping worker pool and draining in-flight dispatches...")
		pool.Stop()
		log.Printf("[RelayGate] Worker pool stopped cleanly.")
	}()

	// Initialize SSE broadcasting Hub
	hub := api.NewHub()

	// Connect Hub to Worker Pool and Ingest Handler
	pool.SetBroadcaster(hub)

	// Initialize HTTP Ingest handler
	ingestHandler := ingest.NewHandler(repo, pool)
	ingestHandler.SetBroadcaster(hub)

	// Initialize API Router
	apiRouter := api.NewRouter(repo, pool, hub)

	// Router setup
	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":    "healthy",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"version":   "1.0.0-PROD",
		})
	})

	// Public ingest receiver
	mux.Handle("POST /ingest/{endpoint_id}", ingestHandler)
	// Fallback route for subpaths if router needs it
	mux.Handle("/ingest/", ingestHandler)
	mux.Handle("/ingest", ingestHandler)

	// Mount REST and SSE API control plane routes
	mux.Handle("/api/v1/", apiRouter)

	// Embedded Vite SPA dashboard handler
	mux.Handle("/", ui.Handler())

	server := &http.Server{
		Addr:         *addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Trap termination signals
	shutdownCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Start server in background
	serverErrChan := make(chan error, 1)
	go func() {
		log.Printf("[RelayGate] Server listening on %s", *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErrChan <- err
		}
	}()

	// Await signal or startup failure
	select {
	case err := <-serverErrChan:
		log.Fatalf("[RelayGate] HTTP server error: %v", err)
	case <-shutdownCtx.Done():
		log.Printf("[RelayGate] Received shutdown signal. Commencing graceful termination...")
	}

	// Graceful shutdown with 10s deadline
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelDrain()

	if err := server.Shutdown(drainCtx); err != nil {
		log.Printf("[RelayGate] HTTP server forced shutdown error: %v", err)
	} else {
		log.Printf("[RelayGate] HTTP server shutdown cleanly.")
	}

	log.Printf("[RelayGate] Shutdown complete. Goodbye.")
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}
