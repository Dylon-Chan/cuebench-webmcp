---
status: accepted
---

# Preserve immutable item revisions

Caption cues and audio-description beats will retain immutable revisions in an append-only Court Record. Mutations require the expected item and revision, stale calls fail without changing state, and undo creates a new revision; changing a Sustained item returns its current revision to Proposed while preserving the previously accepted version.
