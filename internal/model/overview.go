package model

// ThroughputBucket represents a 1-minute slice of event traffic
type ThroughputBucket struct {
	Index  int    `json:"index"`
	Total  int    `json:"total"`
	Failed int    `json:"failed"`
	Label  string `json:"label"`
}

// EndpointBreakdown represents traffic metrics for a single endpoint
type EndpointBreakdown struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Provider    ProviderType `json:"provider"`
	Total       int          `json:"total"`
	Delivered   int          `json:"delivered"`
	Failed      int          `json:"failed"`
	SuccessRate int          `json:"success_rate"`
}
