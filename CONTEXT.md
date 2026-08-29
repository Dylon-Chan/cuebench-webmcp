# CueBench Core

CueBench Core is the domain of collaboratively producing source-language captions and audio description for a video. A person and an agent may both author and revise the work, while final authority to accept rulings and certify the finished project belongs to a person.

## Product

**CueBench**:
The web application in which people and agents collaboratively create, review, and certify accessible media tracks against a shared video timeline.
_Avoid_: Caption Court

## Project and media

**Caption Project**:
A source video together with its working caption track, audio-description track, validation findings, revision history, and certification state.
_Avoid_: Case, document, file

**Caption Track**:
The ordered collection of caption cues associated with a caption project.
_Avoid_: Transcript, subtitles file

**Caption Cue**:
A timed span of spoken text with optional speaker attribution.
_Avoid_: Line, caption, segment

**Audio-Description Track**:
The ordered collection of audio-description beats associated with a caption project.
_Avoid_: AD captions, narration file

**Audio-Description Beat**:
A timed span describing important visual information, normally placed where it does not compete with dialogue.
_Avoid_: Caption cue, scene note

**Transcript Evidence**:
The cloud-generated transcription evidence, including timing and speaker information when available, from which an initial caption draft is produced.
_Avoid_: Certified captions, final transcript

**Word Evidence**:
An aligned source word with canonical Media Time, speaker attribution when available, references to its transcription-pass origins, and uncertainty metadata.
_Avoid_: Caption text, corrected transcript, model token

**Uncertainty Span**:
A bounded interval where transcription passes conflict, evidence is incomplete, or a proposed correction cannot be linked confidently to source words. It requires visible review rather than silent reconciliation.
_Avoid_: Typo, blocking violation, low-quality cue

**Evidence Window**:
A bounded interval containing representative video frames, surrounding transcript evidence, speech-gap information, and the items or findings attached to that moment.
_Avoid_: Entire video, model context

**Media Time**:
An integer number of milliseconds from the beginning of the source video used as the canonical timing coordinate for cues, beats, findings, evidence, and playhead state.
_Avoid_: Frame number, floating-point display time

**Timeline Projection**:
The visible, zoomable projection of Media Time into waveform and track coordinates. It derives from project state and never becomes an independent editable source of truth.
_Avoid_: Project timeline state, waveform model

**Edit Preview**:
A temporary visual timing change shown during a drag or keyboard adjustment before one validated domain command creates a revision, or the view returns to its prior state.
_Avoid_: Autosaved revision, continuous mutation

**Extended-Description Requirement**:
A finding that important visual information cannot fit into available foreground-audio pauses and requires a later extended-description treatment.
_Avoid_: Omitted description, narration overrun

## Collaboration and authority

**Proposed**:
The review state of a cue or beat whose current revision has not been accepted by a person.
_Avoid_: Drafted, pending

**Agent Ready**:
The review state of a cue or beat that an agent believes satisfies the project's rules but a person has not accepted.
_Avoid_: Sustained, approved

**Objected**:
The review state of a cue or beat whose current revision a person has rejected.
_Avoid_: Deleted, failed

**Sustained**:
The review state of a cue or beat whose current revision a person has accepted. Changing its content or timing creates a new Proposed revision.
_Avoid_: Agent-approved, validated

**Ruling**:
A human decision that changes the review state of one or more visible cue or beat revisions. A bulk ruling records every affected item.
_Avoid_: Agent action, certification

**Court Record**:
The append-only chronological record of human and agent actions, including revisions and review decisions, attached to a caption project.
_Avoid_: Chat history, console log

**Revision**:
An immutable version of a caption cue or audio-description beat created by an authored change. Undoing or changing work creates another revision rather than erasing history.
_Avoid_: Snapshot, edit

**Project Revision**:
A monotonically increasing version of the current caption-project state used to detect interleaved or stale project-level actions.
_Avoid_: Item revision, save number

**Remediation**:
Evidence-grounded correction of proposed caption or audio-description work within the shared CueBench timeline.
_Avoid_: Generation, certification

**Human**:
The person who authors content, issues rulings, and holds exclusive authority to certify a project.
_Avoid_: User actor, operator

**Browser Agent**:
The person's browser-hosted agent that discovers CueBench tools and visibly collaborates on the current project.
_Avoid_: CueBench AI, system

**CueBench AI**:
The hosted OpenAI-backed service that generates transcription evidence and proposed media-track content.
_Avoid_: Browser Agent, human

**System**:
CueBench's non-authoring actor for validation, ingest, export, recovery, and other deterministic application events.
_Avoid_: CueBench AI, agent

**Project Certification**:
The human-only decision that a specific certification snapshot is ready to produce certified caption and audio-description exports.
_Avoid_: Agent approval, automatic validation

**Certification Snapshot**:
The immutable set of item revisions, profile revision, warning waivers, and full validation run approved by a Project Certification. Later changes preserve the snapshot but invalidate the project's current certified state.
_Avoid_: Project boolean, latest export

**Blocking Violation**:
A deterministic validation finding that must be resolved before project certification.
_Avoid_: Objection, suggestion

**Quality Finding**:
A profile-revision-specific validation result attached to a project or item revision and classified as a blocking violation or warning.
_Avoid_: Objection, model opinion

**Quality Profile**:
A named, project-configurable collection of deterministic caption and audio-description checks used to find likely technical or readability problems. Passing a quality profile is not a legal accessibility-conformance claim.
_Avoid_: WCAG certification, accessibility guarantee

**Profile Revision**:
An immutable version of a quality profile. Applying a proposed profile change creates a new profile revision and invalidates current full validation and certification.
_Avoid_: Settings update, preset

**Profile Proposal**:
A Browser Agent-authored suggestion to change the quality profile that has no effect until a person applies it.
_Avoid_: Active profile, automatic adjustment

**Warning Waiver**:
A human-authored reason for accepting a non-blocking quality finding without changing the affected revision.
_Avoid_: Fix, ignored warning

**Generation Run**:
A visible, cancellable sequence in which CueBench AI stages transcription evidence and proposed caption or audio-description content, committing it atomically only after successful completion.
_Avoid_: Hidden task, agent session

**Generation Run Receipt**:
A signed, browser-persisted capability that binds an anonymous session, project, operation, and generation run so CueBench can reconnect to unfinished work without an account.
_Avoid_: Account, login token, project data

**Staged Generation Result**:
Private, short-lived structured evidence and proposals produced by a generation run and awaiting revision-checked adoption into the browser-canonical project.
_Avoid_: Saved project, certified track, cloud backup

**Generation Provenance**:
The source hash, provider and resolved model, prompt and schema versions, quality-profile revision, parameters, timings, usage, warnings, and output hash recorded for a generation run.
_Avoid_: Court Record summary, server log, model name

**Target-Track Write Lease**:
A temporary guard held by a generation run that prevents caption or audio-description mutations on its target track while leaving that track inspectable and the other track editable.
_Avoid_: Project lock, certification lock, browser session

**Local Evidence Package**:
The aligned Word Evidence, uncertainty metadata, scene timestamps, and bounded referenced thumbnails retained in IndexedDB after temporary cloud artifacts are deleted.
_Avoid_: Processing copy, project backup, complete frame extraction

**Narration Preview**:
Cached synthetic speech generated on demand for an audio-description beat to evaluate delivery and fit. Its measured duration may create a finding but it is not certification evidence or a rendered narration track.
_Avoid_: Narration Track, certified audio, browser speech

**Draft Export**:
An export of the current working track that does not claim human certification.
_Avoid_: Certified export, final file

**Certified Export**:
An export produced from a human-certified project with no blocking violations.
_Avoid_: Draft export, generated file

**Round-Trip Verified Export**:
A serialized track that CueBench has parsed back into normalized items and compared with its source snapshot before offering the download.
_Avoid_: Validated project, certified export, serializer success

**Project Backup**:
A versioned `.cuebench.json` representation of project structure, revisions, evidence, findings, profiles, Court Record, certification snapshots, hashes, and export metadata that deliberately excludes the source video.
_Avoid_: Media archive, certified export, cloud project

**Impact Summary**:
Project-local measurements of initial and resolved findings, review-state counts, human interventions, time to certification, and round-trip export results. It describes demonstrated work and does not estimate industry-wide time savings.
_Avoid_: Analytics dashboard, productivity claim, compliance score
