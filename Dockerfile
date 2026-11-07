# Stage 1: Build production React assets
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: Build RelayGate static binary
FROM golang:1.22-alpine AS binary-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=ui-builder /app/ui/dist ./ui/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /bin/relaygate ./cmd/relaygate

# Stage 3: Minimal rootless runtime image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 1000 relaygate && \
    adduser -u 1000 -G relaygate -s /bin/sh -D relaygate && \
    mkdir -p /app/data && \
    chown -R relaygate:relaygate /app

COPY --from=binary-builder /bin/relaygate /usr/local/bin/relaygate

USER relaygate
WORKDIR /app
VOLUME ["/app/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/relaygate"]
CMD ["-addr", ":8080", "-db", "/app/data/relaygate.db", "-workers", "10"]
