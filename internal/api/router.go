package api

import (
	"net/http"

	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/worker"
)

// Router sets up control plane HTTP routing and middleware
type Router struct {
	api *API
	mux *http.ServeMux
}

// NewRouter registers all control plane API endpoints
func NewRouter(repo storage.Repository, pool *worker.Pool, hub *Hub) *Router {
	api := NewAPI(repo, pool, hub)
	mux := http.NewServeMux()

	// REST Endpoints (Go 1.22+ pattern matching)
	mux.HandleFunc("GET /api/v1/events", api.ListEvents)
	mux.HandleFunc("GET /api/v1/events/{id}", api.GetEvent)
	mux.HandleFunc("POST /api/v1/events/{id}/replay", api.ReplayEvent)
	mux.HandleFunc("POST /api/v1/events/bulk-replay", api.BulkReplay)

	mux.HandleFunc("GET /api/v1/endpoints", api.ListEndpoints)
	mux.HandleFunc("POST /api/v1/endpoints", api.CreateEndpoint)
	mux.HandleFunc("PATCH /api/v1/endpoints/{id}", api.UpdateEndpoint)

	mux.HandleFunc("GET /api/v1/stats", api.GetStats)
	mux.HandleFunc("GET /api/v1/overview", api.GetOverview)
	mux.HandleFunc("GET /api/v1/stream", api.StreamSSE)

	// Auth Endpoints
	mux.HandleFunc("POST /api/v1/auth/register", api.Register)
	mux.HandleFunc("POST /api/v1/auth/login", api.Login)

	return &Router{
		api: api,
		mux: mux,
	}
}

// ServeHTTP delegates to internal mux while injecting CORS headers
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Enable CORS for local Vite dev server and cross-origin tools
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Cache-Control")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rt.mux.ServeHTTP(w, r)
}
