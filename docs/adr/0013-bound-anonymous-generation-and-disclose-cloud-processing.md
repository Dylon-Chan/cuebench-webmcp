---
status: accepted
---

# Bound anonymous generation and disclose cloud processing

CueBench Core will protect its public OpenAI-backed generation with Cloudflare Turnstile, signed anonymous sessions, per-session and per-network quotas, a global spend circuit breaker, supported-media validation, and limits of 15 minutes and 500 MB per media source. Before upload, the interface will identify temporary Cloudflare storage, OpenAI processing, bounded retention, and deletion behavior. Visitors will not supply API keys or create accounts. Local development will use Wrangler with the real media container, deterministic fixture replay for automated tests, and opt-in real OpenAI calls through environment configuration.
