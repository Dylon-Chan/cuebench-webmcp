---
status: accepted
---

# Separate media preparation from AI orchestration

A Python 3.12 Cloudflare Container will use FFmpeg and FFprobe to deterministically inspect media, normalize audio, extract bounded frame evidence, and produce waveform peaks and artifact manifests. Cloudflare Workflows will own OpenAI credentials, model requests, retries, progress, and staged-result assembly. The Container receives only job-scoped signed storage locations and never receives the OpenAI API key. This keeps media mechanics reproducible and limits credential exposure without pushing CPU-heavy work into the Worker or browser.
