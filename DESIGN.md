---
name: CueBench Calibration Bench
description: A precision caption-certification instrument for calibrating media text against visible evidence.
colors:
  cool-paper: "#fbfbfb"
  paper-raised: "#ffffff"
  ink: "#13212a"
  heading-ink: "#102933"
  muted-reading: "#60767e"
  cool-divider: "#b7c5ca"
  header-abyss: "#010f1c"
  header-mid: "#061923"
  instrument-well: "#0a1b23"
  timeline-bed: "#071820"
  signal: "#006836"
  signal-deep: "#005b36"
  signal-mint: "#64e090"
  playhead-mint: "#57ea96"
  evidence-blue: "#0f3450"
  evidence-blue-line: "#63a8d6"
  diagnostic-amber: "#d9ad35"
  diagnostic-amber-field: "#ffe9bd"
  object-action: "#9b3d00"
  object-marker: "#e86300"
  sustain-action: "#8050b3"
  sustain-marker: "#9657c7"
  authority-ink: "#633083"
  authority-line: "#bda7ca"
  authority-field: "#faf6fc"
typography:
  display:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2.4rem, 6vw, 5.5rem)"
    fontWeight: 780
    lineHeight: 0.93
    letterSpacing: "-0.04em"
  headline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.06rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.82rem"
    fontWeight: 760
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 520
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.65rem"
    fontWeight: 740
    lineHeight: 1.2
    letterSpacing: "0.045em"
  control:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.82rem"
    fontWeight: 720
    lineHeight: 1
    letterSpacing: "normal"
  field:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.72rem"
    fontWeight: 520
    lineHeight: 1.4
    letterSpacing: "normal"
  measurement:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.63rem"
    fontWeight: 680
    lineHeight: 1.35
    letterSpacing: "normal"
    fontFeature: '"tnum" 1'
rounded:
  indicator: "2px"
  field: "3px"
  control: "4px"
  surface: "5px"
  dialog: "6px"
spacing:
  xs: "0.25rem"
  sm: "0.35rem"
  md: "0.55rem"
  lg: "0.7rem"
  surface: "10px"
  panel: "12px"
components:
  button-signal:
    backgroundColor: "{colors.signal}"
    textColor: "#f6fff9"
    typography: "{typography.control}"
    rounded: "{rounded.surface}"
    padding: "0.48rem 0.82rem"
  button-signal-hover:
    backgroundColor: "{colors.signal-deep}"
    textColor: "#f6fff9"
    rounded: "{rounded.surface}"
  button-outline:
    backgroundColor: "{colors.cool-paper}"
    textColor: "#0e3948"
    typography: "{typography.control}"
    rounded: "{rounded.surface}"
    padding: "0.48rem 0.82rem"
  button-object:
    backgroundColor: "{colors.object-action}"
    textColor: "#fff9f5"
    typography: "{typography.control}"
    rounded: "{rounded.surface}"
    padding: "0.48rem 0.82rem"
  button-sustain:
    backgroundColor: "{colors.sustain-action}"
    textColor: "#fffaff"
    typography: "{typography.control}"
    rounded: "{rounded.surface}"
    padding: "0.48rem 0.82rem"
  human-ruling-field:
    backgroundColor: "{colors.authority-field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.72rem"
  review-field:
    backgroundColor: "{colors.paper-raised}"
    textColor: "#152e38"
    typography: "{typography.field}"
    rounded: "{rounded.field}"
    padding: "0.42rem 0.46rem"
  docket-filter-active:
    backgroundColor: "#edfff4"
    textColor: "{colors.signal-deep}"
    rounded: "{rounded.control}"
    padding: "0.35rem 0.48rem"
  timeline-caption-selected:
    backgroundColor: "#075737"
    textColor: "#eaf5f1"
    rounded: "{rounded.field}"
    height: "40px"
---

# Design System: CueBench Calibration Bench

## Overview

**Creative North Star: "Calibration Bench"**

CueBench is a precision caption-certification instrument: a calm daylight workbench where a teacher and bounded agent calibrate captions and audio descriptions against visible media evidence. Cool paper surrounds deep teal-navy instrument wells; mint signal traces, amber diagnostics, evidence blue, and purple Human authority create a dense but controlled field whose hierarchy comes from measurement, not decoration.

The surface borrows optical glass, anodized edges, etched grids, and tabular readings without becoming literal laboratory scenery. Legal-review language is functional: the Review Docket organizes current review state, Human rulings bind saved revisions, and the Court Record preserves append-only provenance. It must never drift into a generic dashboard, an AI gradient, courtroom cosplay, a chat layout, or neon science fiction.

**Key Characteristics:**

- Dense, evidence-first composition with the artifact always visible.
- Cool paper framing around inset graphite instruments.
- Mint signal and selection; amber diagnosis; blue evidence; purple Human authority.
- Shape plus label plus color for every consequential state.
- Restrained 2–6 px corners, fine dividers, and tabular measurement readings.

## Colors

The palette behaves like a calibrated instrument: cool neutrals carry structure, dark wells carry time-based evidence, and semantic accents are scarce and explicit.

### Primary

- **Verified Signal:** `signal`, `signal-deep`, `signal-mint`, and `playhead-mint` identify current selection, live evidence, playback position, accepted feedback, and primary completion actions.

### Secondary

- **Evidence Blue:** `evidence-blue` and `evidence-blue-line` belong to audio-description beats, available speech gaps, and evidence-linked intervals—not general navigation.

### Tertiary

- **Diagnostic Amber:** `diagnostic-amber` and `diagnostic-amber-field` identify warnings and measured attention states.
- **Object:** `object-action` is the Human rejection action; `object-marker` marks objected or blocking states.
- **Human Authority:** `sustain-action` is the Human acceptance action; `sustain-marker` identifies sustained state. `authority-ink`, `authority-line`, and `authority-field` make the ruling area a complete inset material field rather than a loose action row or side tab.

### Neutral

- **Cool Paper:** `cool-paper` is the page ground; `paper-raised` is reserved for readable controls and the brightest face of framed surfaces.
- **Ink:** `ink` and `heading-ink` carry readable interface and transcript text; `muted-reading` carries secondary measurements.
- **Instrument Dark:** `header-abyss`, `header-mid`, `instrument-well`, and `timeline-bed` create the header, video transport, waveform, and lane bed.
- **Cool Divider:** `cool-divider` defines the workbench's fine structural rules.

### Named Rules

**The Authority Color Rule.** Purple belongs to Human-only authority and sustained state; never use it to imply agent approval.

**The Signal Scarcity Rule.** Mint identifies the shared clock, verified evidence, active selection, or successful action; it is not ambient decoration.

## Typography

**Display Font:** system UI sans stack
**Body Font:** system UI sans stack
**Label/Mono Font:** system UI sans with tabular numerals; diagnostic receipts may use the shipped platform monospace stack.

**Character:** Typography is compact, workhorse, and conventionally readable. Technical character comes from weight, casing, tracking, and tabular numerals—not from rendering caption prose as oscilloscope lettering.

### Hierarchy

- **Display:** `display` is limited to the project-start statement.
- **Headline:** `headline` names primary evidence regions.
- **Title:** `title` labels timeline lanes, selected items, and Human ruling panels.
- **Body:** `body` carries caption prose, evidence explanation, and controls.
- **Label:** `label` is used for short uppercase measurement and state labels.
- **Measurement:** `measurement` keeps times, revisions, counts, and hashes aligned with tabular numerals.

### Named Rules

**The Transcript Legibility Rule.** Caption and audio-description prose always uses the body voice; measurement styling is reserved for IDs, times, counts, and provenance.

## Layout

The desktop workbench uses a two-column grid (`minmax(0, 1.8fr) minmax(290px, 0.95fr)`) with a 10 px gutter and 10 px outer inset. The Evidence Bay owns the larger left column, the scroll-contained Review Docket owns the right, and the Court Record spans both columns. The instrument header is a continuous 68 px minimum-height rail rather than a collection of floating cards.

At 1180 px the header drops its separate Calibration Bench identity, retains the two-column workbench, and compresses the right column to `minmax(310px, 0.72fr)`. At 820 px the surface becomes one column, removes the Docket height cap, and keeps Court Record entries in two columns. At 540 px it becomes the shipped semantic sequence: header actions, Evidence Bay, selected-item summary, shared timeline, Review Docket, then Court Record and supporting panels. Page-level horizontal overflow remains clipped.

On first mobile display below 540 px, the shared timeline initializes at 3× zoom. When a selected cue or audio-description beat is present or changes, the visible 3× interval recenters around that selection without resetting zoom. Waveform, captions, audio-description gaps/beats, finding markers, and the single native-clock playhead remain aligned; Earlier/Later and zoom controls provide bounded navigation.

All consequential mobile controls use a 44 px minimum target, including header actions, Docket filters, transport controls, range inputs, timeline tools, finding markers, selected timing handles, ruling actions, fields, and Court Record links. The canvas waveform is evidence only; semantic cue/beat buttons, range input, and slider-role boundary handles expose equivalent keyboard and assistive interaction.

## Elevation & Depth

Depth is structural and mostly inset. Light paper surfaces receive a faint etched lift, while video and timeline wells use layered outlines, inner highlights, and dark inset shading to read as glass seated in an anodized frame. Modal dialogs alone receive unmistakable floating elevation.

### Shadow Vocabulary

- **Paper Surface** (`inset 0 1px 0 #fff, 0 4px 12px rgb(24 50 59 / 8%)`): Evidence Bay, Review Docket, and Court Record.
- **Optical Specimen** (`0 0 0 3px #dce4e5, 0 0 0 4px #9dabb0, inset 0 0 0 1px rgb(223 245 241 / 16%), inset 0 -22px 40px rgb(0 4 12 / 36%), 0 8px 18px rgb(25 49 59 / 18%)`): the strongest glass edge, reserved for source video.
- **Timeline Instrument** (`0 0 0 2px #d8e1e2, 0 0 0 3px #a9b7bb, inset 0 1px 0 rgb(223 247 241 / 13%), 0 8px 17px rgb(18 43 52 / 14%)`): the shared waveform and lane assembly.
- **Dialog Lift** (`0 22px 50px rgb(0 15 23 / 34%)`): blocking storage, export, backup, and ruling dialogs.

### Named Rules

**The Inset-First Rule.** Evidence surfaces are seated into the workbench; floating-card shadows are reserved for modal interruption.

## Shapes

The form language is precise and restrained. Fields and state labels use `field`; tabs, ruling panels, and lane shells use `control`; primary surfaces use `surface`; dialogs use `dialog`. The video specimen uses a 4 px inner glass corner inside its outline stack. The Human ruling field is enclosed on all four sides with a continuous purple line, a pale authority wash, and an inset highlight; it never collapses into a side tab or separator-only treatment. General containers are never pills. Selected timeline items and Docket rows add a 2 px signal outline to their filled state, while diamond finding markers remain a compact rotated-square exception.

## Components

### Buttons

- **Shape:** Compact framed controls use `surface`, a 1 px current-color border, 38 px minimum height, and `0.48rem 0.82rem` padding.
- **Primary:** `button-signal` is the verified completion action; its restrained lift is structural, not glossy.
- **Hover / Focus:** Signal hover shifts to `button-signal-hover`. All keyboard focus uses a 3 px `signal` outline with a 3 px offset. State transitions are limited to border color and shadow over 160 ms ease-out.
- **Outline:** `button-outline` keeps secondary workbench actions quiet against paper.
- **Human ruling:** Object and Sustain use their dedicated semantic action tokens, always with explicit text and the surrounding “Human-only” label inside the complete `human-ruling-field` enclosure.
- **Disabled:** Disabled controls use a pale gray field, remove lift, and retain a not-allowed cursor.

### Chips

- **Style:** Docket filters are compact rounded rectangles with a 30 px minimum height on desktop. The pressed state uses a pale signal field, green border, explicit label, and inset 2 px signal rule.
- **State:** Review-state badges pair uppercase text with distinct border, background, and color; Proposed, Agent Ready, Objected, and Sustained are never color-only.

### Cards / Containers

- **Corner Style:** Primary containers use `surface`; selected Docket rows use `control`.
- **Background:** Paper surfaces use a near-white diagonal tonal shift. Selected rows use a pale signal field; instrument content moves into the dark wells.
- **Shadow Strategy:** Follow the inset-first vocabulary above.
- **Border:** One-pixel cool-slate borders and dividers organize density; selection adds a 2 px signal outline.
- **Internal Padding:** Major paper regions use 10–12 px; compact internal modules use roughly `0.55rem–0.72rem`.
- **Human Authority Field:** Human rulings sit in a self-contained 4 px-corner material region with a 1 px purple perimeter, pale purple base, narrow top wash, and inset highlight. The enclosure—not a tab edge—owns the heading, explanation, and both ruling actions.

### Inputs / Fields

- **Style:** `review-field` is a white, 1 px cool-slate field with a 3 px corner and compact body type. Labels sit above in small tracked text.
- **Focus:** Keyboard focus uses the global 3 px signal outline and shifts the field border to signal.
- **Error / Disabled:** Invalid fields use an orange-brown border and a 2 px translucent error halo; disabled states must remain labeled and legible.

### Navigation

- **Style:** The dark continuous instrument rail carries brand, project/validation/storage/WebMCP readings, and compact framed actions. Below 540 px, actions become a two-column grid of full-width 44 px controls, followed by explicit compact storage and WebMCP status.

### Shared Timeline

The timeline is the signature instrument: green waveform evidence, a ruled time scale, caption lane, audio-description lane, amber/orange finding diamonds, and one mint playhead driven by the native video clock. Caption intervals are dark teal; audio-description intervals and dashed speech gaps use evidence blue. Only the selected interval exposes real start/end slider handles; at mobile those handles and markers expand to 44 px targets. Reduced-motion mode reduces all transition and animation durations to 0.01 ms, limits animation iteration to one, and disables smooth scrolling.

### Review Docket, Human Rulings, and Court Record

The Docket is current review state: filters, complete readable item text, timings, speaker, revision, evidence links, editor, findings, and AD gap composer. Object and Sustain bind the displayed saved revision and remain Human-only; unsaved drafts block rulings. Their heading, explanation, and paired actions stay together inside the fully enclosed purple inset field at desktop and mobile widths. The Court Record is a shallow append-only ledger of project revision, actor, event, immutable revision ancestry, and evidence or reason detail. It may filter by actor or reveal more history, but must never resemble a chat transcript.

## Do's and Don'ts

### Do:

- **Do** keep source video, waveform, caption lane, audio-description lane, findings, selected revision, and the single playhead visibly connected.
- **Do** use shape plus label plus color for selection, warning, actor, and review state.
- **Do** preserve 44 px minimum touch targets and semantic alternatives on mobile.
- **Do** keep Human-only rulings inside the fully enclosed purple inset field, with the orange Object and purple Sustain actions structurally separate from agent actions.
- **Do** treat the Court Record as append-only provenance with exact actors and revisions.

### Don't:

- **Don't** use generic dashboard cards, AI gradients, decorative glow, or a chat-centric layout.
- **Don't** turn the Calibration Bench into literal laboratory scenery, neon science fiction, or courtroom ornament.
- **Don't** use instrument lettering for transcript or audio-description prose.
- **Don't** make waveform canvas interaction the only way to select, seek, or adjust timing.
- **Don't** reduce Human rulings to a colored side tab, top rule, or detached pair of buttons; preserve the complete authority-field enclosure.
- **Don't** imply that agent readiness, deterministic validation, or color alone is Human certification.
