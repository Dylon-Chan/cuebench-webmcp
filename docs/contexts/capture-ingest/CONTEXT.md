# Capture & Ingest

Capture & Ingest makes source video available to CueBench projects without defining or modifying its accessible media tracks.

## Language

**Media Source**:
The video selected, imported, or recorded as the evidence against which accessible media tracks are authored.
_Avoid_: Input, asset, evidence file

**Ingest**:
The act of making a media source available to a caption project.
_Avoid_: Upload, import

**Temporary Processing Copy**:
A private, short-lived copy of a media source uploaded directly to object storage solely for hosted preparation and generation. It is deleted after success or cancellation; failed work may retain it for bounded recovery before lifecycle deletion.
_Avoid_: Cloud project, backup, permanent upload

**Prepared Media Evidence**:
Bounded audio chunks, representative frames, timing metadata, and other transient derivatives created from a temporary processing copy for CueBench AI.
_Avoid_: Caption track, project state, original media

**Waveform Peak Pyramid**:
A compact set of deterministic minimum-and-maximum audio-amplitude buckets at multiple resolutions used to render the timeline without decoding the source video in the browser.
_Avoid_: Audio track, transcript evidence, decorative waveform

**Anonymous Processing Session**:
A signed, rate-limited authorization to upload one bounded media source and operate its hosted jobs without creating an account.
_Avoid_: User account, public upload URL, API key

**Media Relink**:
The human selection of a source video after importing a Project Backup, accepted only when its SHA-256 hash matches the backup's Media Source descriptor.
_Avoid_: Upload recovery, duration match, media replacement

**Temporary Session Project**:
An explicitly disclosed project mode used when the browser cannot grant sufficient persistent storage. It remains usable in the current session but does not promise recovery after the tab or browser closes.
_Avoid_: Saved project, anonymous project default, incognito detection
