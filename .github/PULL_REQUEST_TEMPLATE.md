## Summary

Describe what changed and why.

## Type of Change

- [ ] Bug fix
- [ ] New feature or provider
- [ ] UI or accessibility improvement
- [ ] Documentation or CI update

## Verification Checklist

- [ ] `npm --prefix ui test` passed
- [ ] `npm --prefix ui run build` succeeded (embedded `ui/dist` updated if `ui/` changed)
- [ ] `go test -count=1 ./...` passed (or `./internal/...` and `./test -skip TestProdDatabaseState` when using a populated local dev DB)
- [ ] `CGO_ENABLED=0 go build ./cmd/relaygate` and `./cmd/relaygate-agent` succeeded
- [ ] Verified changes follow neutral `zinc` tokens, accessibility (`44px` touch targets, keyboard navigation), and security boundaries (`CONTRIBUTING.md`)
