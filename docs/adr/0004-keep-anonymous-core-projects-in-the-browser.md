---
status: superseded
superseded-by: 0012
---

# Keep anonymous Core projects in the browser

CueBench Core will be a hosted, no-account application that persists projects and source video in the person's browser. Its server passes transcription media transiently to OpenAI without durably storing it; durable cloud media, resumable long-running jobs, and shared accounts belong to Professional Scale.

This decision is superseded because reliable anonymous processing requires a short-lived private processing copy and a recoverable hosted job. The browser remains canonical under ADR 0012.
