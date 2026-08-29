# CueBench Context Map

## Contexts

- [Core Authoring](./CONTEXT.md): creates, reviews, validates, and certifies source-language caption and audio-description tracks
- [Capture & Ingest](./docs/contexts/capture-ingest/CONTEXT.md): turns bundled media, uploads, URLs, webcams, and screen recordings into project media sources
- [Localization](./docs/contexts/localization/CONTEXT.md): derives and reviews target-language subtitle tracks from a certified source caption track
- [Voice & Mix](./docs/contexts/voice-mix/CONTEXT.md): generates narration and dubbed speech, aligns audio, and renders final media
- [Professional Scale](./docs/contexts/professional-scale/CONTEXT.md): adds durable accounts, long-media operations, secondary agent quality review, and explicit batch automation without changing human certification authority

## Relationships

- **Capture & Ingest → Core Authoring**: supplies the source video used by a caption project
- **Core Authoring → Localization**: supplies the certified source caption track from which translation tracks are derived
- **Core Authoring → Voice & Mix**: supplies sustained audio-description beats for narration generation
- **Localization → Voice & Mix**: supplies reviewed translation tracks for dubbing
- **Voice & Mix → Core Authoring**: returns rendered outputs without changing the certified text tracks that produced them
- **Core Authoring → Professional Scale**: supplies the revision, validation, ruling, certification, and narrow-tool semantics that scaled workflows must preserve
- **Professional Scale → Capture & Ingest**: adds durable media storage, resumable ingest, and long-video preparation
- **Professional Scale → Localization / Voice & Mix**: coordinates larger multi-track projects and rendered deliverables without merging their domain models
