---
status: accepted
---

# Align two OpenAI transcription passes

CueBench will preserve and align two transcription results: `gpt-4o-transcribe-diarize` supplies speaker-labelled segments, while `whisper-1` supplies word-level timestamps. Derived cues retain alignment confidence and surface uncertain spans for review because neither OpenAI response alone provides both kinds of evidence.
