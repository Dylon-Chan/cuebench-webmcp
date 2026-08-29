---
status: accepted
---

# Generate evidence before track proposals

Caption generation will align a diarized transcription with `whisper-1` word timestamps into Word Evidence before creating cues. A configurable structured-output model role, defaulting to `gpt-5.6-terra` with response storage disabled, may reconcile bounded conflicts only when every changed word maps to source evidence; unresolved conflicts become Uncertainty Spans. Deterministic Quality Profile rules segment the reconciled evidence into Proposed cues.

Audio-description generation will build adaptive 45–90 second evidence windows from scene changes, speech gaps, and transcript boundaries, with overlap and no more than twelve representative frames. The model proposes necessity, text, and frame references; deterministic logic chooses viable timing, deduplicates overlaps, and flags narration that cannot fit as an Extended-Description Requirement. On-demand `gpt-4o-mini-tts` previews default to the `marin` voice, are cached by their complete inputs, and are measured for fit without becoming certification evidence. The browser retains a bounded Local Evidence Package after temporary cloud artifacts are deleted.
