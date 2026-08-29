---
status: accepted
---

# Serialize generation and lease only the target track

CueBench Core will run at most one caption or audio-description Generation Run at a time, with caption evidence required before audio-description generation. A run holds a Target-Track Write Lease: people and agents may inspect its target track but cannot mutate that track until the run completes or is cancelled; the other track remains editable, while profile and media replacement are blocked. Workflows retry failed stages, record complete Generation Provenance, and atomically adopt the staged result only after all stages and revision checks succeed. Exhausted failure or cancellation adopts nothing.
