# CueBench demonstration runbook

The primary story is a teacher preparing a short lesson for Deaf and hard-of-hearing learners. Use the original bundled 90-second Gibbs free-energy clip. It contains two speakers, “Dr. Nguyen,” technical terminology, an ambiguous joke, visible slide text, and a silent diagram that needs audio-description judgment.

## Before judges arrive

- Open the public production HTTPS URL in the current WebMCP-capable browser.
- With Cloudflare account/token credentials available only in the process environment, run `CUEBENCH_SMOKE_TURNSTILE_MODE=human bash scripts/smoke-hosted.sh "$CUEBENCH_PRODUCTION_URL"` from the reviewed release checkout and complete the real Turnstile challenge in the headed browser.
- Confirm production Turnstile, live OpenAI mode, the spend breaker, and the five-minute cleanup cron.
- Confirm the smoke's real bounded generation and cancel/delete cleanup evidence. Record only the pass/fail result and opaque metadata.
- Keep a second fresh browser profile ready for the explicitly labelled Demonstration replay fallback.
- Download and re-import one VTT before recording. Do not rely on a cached Blob URL from an older project revision.

## Under-three-minute path

1. Open **Gibbs lesson**. Point out that source media and the working project are browser-canonical.
2. Accept the cloud disclosure and run real caption generation. The visible stages create transcript evidence and Proposed cues; they do not make Human rulings.
3. Focus the proper-name/quality finding. The shared playhead, timeline, evidence, and docket move to the same moment.
4. Ask the personal Browser Agent to inspect and revise the selected cue. Show that selection-scoped WebMCP tools exist only for that visible cue and return the updated revision after the DOM changes.
5. Sustain the revision yourself. State that Sustain, Object, profile application, waivers, deletion, and certification are deliberately absent from WebMCP.
6. Select the silent diagram gap and have the agent propose one AD beat. Preview or review it, then make the Human ruling.
7. Run deterministic validation, resolve or explicitly waive remaining warnings as a Human, and certify the exact snapshot.
8. Export certified caption VTT. Show the `.certified.vtt` filename, round-trip verification, successful re-import, and distinct Human/Browser Agent/CueBench AI/System actors in the Court Record.

## External-service fallback

If Cloudflare/OpenAI generation is unavailable, say so plainly and choose **Run demonstration replay**. The interface labels it **Demonstration replay** and states that it is deterministic and non-live. It exercises the real browser lease, atomic adoption, immutable revisions, validation, Court Record, remediation, certification, and export paths; it does not pretend to prove a provider request. Continue the same selection-scoped WebMCP/Human-authority loop from step 3.

Never call the replay “AI generation,” never claim that uploaded media stays on-device, and never describe deterministic validation as WCAG or legal certification.

## Evidence to call out

- Initial and remaining Quality Profile findings.
- Corrected “Dr. Nguyen” and preserved scientific terminology.
- One visible Human judgment that the generating pass could not safely make.
- Human-only ruling and certification controls.
- Round-trip-verified VTT MIME/filename and successful parse.
- Court Record attribution and immutable revision history.
- Cleanup state: `Deleted` when acknowledged, otherwise the truthful `Lifecycle pending` plus its 24-hour backstop.
