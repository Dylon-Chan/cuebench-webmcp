# CueBench Workbench Surface Brief

## Scope and job

- Mode: Operate.
- Primary task: review, repair, validate, human-rule, certify, and export caption and audio-description work against one visible video timeline.
- Approved composition: `.impeccable/mocks/decision/calibration-bench.png` (option 1).
- Memorable moment: selecting C05 creates one bright vertical time reference through the video context, waveform, caption span, evidence finding, and docket detail while Object and Sustain remain visibly human-only.

## Hierarchy

1. Compact instrument header: CueBench identity, project, validation progress, quality state, WebMCP connection, settings, export.
2. Large video specimen bay in the upper-left, with familiar native transport and optical-glass framing.
3. Calibrated waveform and multi-lane timeline directly beneath the video, sharing the native media clock.
4. Review Docket on the right: status filters, readable cue list, selected revision, evidence, and human rulings.
5. Shallow Court Record across the bottom: append-only provenance without becoming a chat transcript.

## Responsive intent

- Desktop at and above 1180 px preserves the approved two-column topology and keeps all five regions in the first working viewport.
- Tablet compresses the docket width and allows the Court Record to collapse to its latest entry while keeping video and timeline stacked together.
- Mobile becomes a semantic single-column workbench: video, selected-cue summary, timeline overview, docket, then record. The cue/beat lists expose every operation available on the canvas; horizontal timeline pan is allowed, page-level horizontal overflow is not.
- Focus, selected state, warnings, and actor identity always use shape plus label plus colour. Reduced-motion mode removes animated signal sweeps and scroll transitions.

## Component grammar

- Ground: cool near-white work surface sampled at `#fbfbfb`; graphite measurement fields sampled at `#0a1b23`; header extremes sampled from `#010f1c` to `#000208`.
- Verified signal: dark oscilloscope green fields sampled from `#005b36` to `#006836`, paired with a bright green line and explicit state label.
- Attention: amber marker field sampled at `#b69330`; Object orange sampled at `#e86300`; Sustain purple sampled at `#9657c7`; information blue uses the pale field family sampled near `#d0eafb`.
- Corners: restrained 4–6 px radii; no pill-shaped general containers. Status chips may use compact rounded rectangles.
- Lines: 1 px cool-slate dividers on light surfaces; low-contrast etched grid on graphite; active selections use a 2 px signal-colour outline plus filled state.
- Elevation: mostly inset optical/instrument layering, not floating cards. Video receives the strongest glass edge; docket and record stay flush to the work surface.
- Type: workhorse sans for interface and transcript prose; tabular numerals for timings and measurements. Transcript text never adopts display/oscilloscope lettering.
- Motion: one shared playhead and bounded signal response; selection transitions may seek and focus, but nothing pulses indefinitely except a quiet live-status indicator.

## Fidelity inventory

| Visible ingredient | Composition commitment | Implementation medium |
| --- | --- | --- |
| Instrument header | One compact continuous rail with project, progress, quality, WebMCP, settings, export | Semantic HTML/CSS with icon library |
| Video specimen bay | Largest upper-left region with teacher/slide evidence and familiar transport | Native `<video>` plus semantic controls and bundled sample media |
| Optical edge/material | Thin anodized frame and glass inset, never a floating marketing card | CSS borders, inset shadows, and restrained highlights |
| Waveform | Dense green amplitude signal across the shared scale | Canvas using the multi-resolution min/max peak pyramid |
| Shared playhead | One vertical green reference crossing waveform and all timeline lanes | HTML/CSS overlay driven by the native video clock |
| Caption and AD spans | Labelled, readable, lane-bound intervals with shape/label/colour states | Semantic list controls projected into CSS-positioned timeline spans |
| Timeline grid and ticks | Fine ruled measurement bed with meaningful time labels | Canvas/SVG scale plus CSS lane grid |
| Review Docket | Full readable cue rows, filters, selected revision, evidence, rulings | Semantic HTML, Radix primitives only where behavior warrants them |
| Human rulings | High-salience Object and Sustain actions in orange and purple | Native buttons; never registered as WebMCP tools |
| Court Record | Shallow append-only ledger across the bottom | Semantic table/list with actor and revision links |
| Icons | Exact functional symbols without decorative tile containers | Lucide or equivalent coherent icon library |
| Background texture | No raster texture required; material is precise code-native instrumentation | CSS only; accepted omission of decorative raster grain |

## Must not be literalized

- Generated teacher imagery is composition evidence, not a shipping source asset; use the original bundled sample video instead.
- Small generated copy and counts are layout examples; runtime state and validated sample data are authoritative.
- Preserve the topology and density without rasterizing any UI text, controls, waveform, or timeline.
- The legal vocabulary stays functional. Do not add gavels, seals, columns, courtroom ornament, or a chat panel.
