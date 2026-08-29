---
status: accepted
---

# Back up project structure separately from source media

CueBench Core will export a versioned `.cuebench.json` Project Backup containing project structure, immutable revisions, Local Evidence Package, findings, profiles, Court Record, certification snapshots, hashes, and export metadata, but not the source video. Import is a human-only previewed action that creates a new project or replaces an explicitly selected project and requires Media Relink to a video with the recorded SHA-256 hash. Schema versions migrate stepwise after a safety backup; unsupported newer schemas open read-only. Every VTT, SRT, and AD timed-text export must pass a normalized parse-and-compare round trip before download.
