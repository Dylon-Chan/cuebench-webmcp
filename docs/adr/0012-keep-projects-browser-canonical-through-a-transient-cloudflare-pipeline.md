---
status: accepted
supersedes: 0004
---

# Keep projects browser-canonical through a transient Cloudflare pipeline

CueBench Core will run as a hosted Cloudflare application. IndexedDB remains the canonical store for anonymous project state and source video. The browser uploads a bounded temporary processing copy directly to private R2; a Cloudflare Workflow coordinates an FFmpeg Container and OpenAI calls; staged structured results are retained privately long enough for a signed run receipt to recover them after a tab closes. Adoption into the project requires the expected project revision. Successful or cancelled work deletes its processing media, failed work may be retried for up to 24 hours, and R2 lifecycle rules provide a deletion backstop. Cloud job storage is processing state, not a cloud project or collaboration store.
