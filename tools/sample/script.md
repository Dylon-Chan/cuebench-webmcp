# CueBench original demonstration lesson

`gibbs-free-energy-sample-v1` is an original, approximately 90-second, two-speaker lesson created for the CueBench public demonstration. The written script and SVG artwork in this directory are repository-authored. No stock footage, recorded person, cloned voice, or third-party lesson is used.

## Exact timeline

| Time | Speaker | Authored beat and spoken copy |
| --- | --- | --- |
| 00:00–00:10 | Dr. Nguyen | “I’m Dr. Nguyen. In the next ninety seconds, we’ll calibrate our intuition for Gibbs free energy.” |
| 00:10–00:18 | Dr. Nguyen | “Delta G equals delta H minus temperature times delta S. It compares the energy available before and after a change.” |
| 00:18–00:27 | Dr. Nguyen | “When delta G is negative, the change is thermodynamically spontaneous under those conditions.” |
| 00:27–00:35 | Student | “Does spontaneous mean the reaction happens fast, like the moment we mix the chemicals?” |
| 00:35–00:42 | Dr. Nguyen | “Good question. Spontaneous is willing, not necessarily speedy.” |
| 00:42–00:50 | Dr. Nguyen | “A diamond is willing to become graphite, but it takes its time about it.” |
| 00:50–01:05 | — | Speech pauses. A watershed-style reaction-progress diagram fills the slide long enough for an audio-description proposal. |
| 01:05–01:13 | Dr. Nguyen | “Negative delta G favors products. At zero, the system is at equilibrium. Positive delta G favors reactants.” |
| 01:13–01:20 | Dr. Nguyen | “So the sign tells us the favored direction, not the clock speed.” |
| 01:20–01:25 | Student | “Direction, not speed. That distinction is the useful part.” |
| 01:25–01:30 | Dr. Nguyen | “Exactly. I’m Dr. Nguyen, and that’s your Gibbs free energy calibration.” |

The reference transcript records the authored segment bounds. The deterministic replay subdivides words evenly inside those bounds; it does not claim that those token times came from a live speech provider.

## Deliberate review challenges

The replay is intentionally imperfect so the demo exercises collaboration instead of presenting a pre-certified answer:

- the first `Dr. Nguyen` is proposed as `Dr. Wynn`;
- the Student question is proposed with an `Unknown` speaker;
- exactly one caption exceeds the Education Profile’s seven-second duration, so the duration finding is intentional and countable;
- the joke caption is intentionally too fast to read;
- “spontaneous” needs human interpretation, not only spelling correction;
- `ΔG = ΔH − TΔS` appears as meaningful slide text;
- the silent diagram creates an audio-description judgment that captions alone cannot settle.

## Media and voice provenance

- **Writing:** original CueBench demonstration copy in this file.
- **Imagery:** original vector artwork in `slides/lesson.svg`; it uses only SVG shapes and text.
- **Voices:** the narration was originally synthesized offline on macOS 26.5.1 (25F80) using the installed `Samantha` en-US voice for Dr. Nguyen and `Daniel` en-GB voice for the Student. No recorded person is represented. The exact finalized 48 kHz stereo FLAC mix is checked in at `audio/gibbs-free-energy-narration-mix.flac`; its SHA-256 and byte length are pinned in `reference-project.json`. This records production facts only and makes no separate licensing representation.
- **Reproducible input:** the default build consumes that checked-in lossless mix. It does not call `say`, download a voice, or regenerate mutable system-voice output. Voice regeneration is intentionally outside this deterministic build and would require an explicit provenance and hash update.
- **Assembly:** the exact cached image id, FFmpeg version, Dockerfile hash, FLAC hash, SVG hash, transcript hash, and replay-record hash are pinned in `reference-project.json`. The Debian Bookworm FFmpeg image produces the bounded H.264/AAC MP4 with metadata stripped and fixed encoding parameters.
- **Network scope:** playback and deterministic replay need no network or provider account. Verification needs the exact cached pinned image. A clean Docker image build needs network access for the digest-pinned bases and pinned Debian packages; after that, assembly runs with Docker networking disabled.

`node --experimental-strip-types tools/sample/build-sample.ts --check-determinism` performs two complete builds in independent temporary directories and requires identical MP4 SHA-256 values. `--verify` checks the shipped media and every pinned repository input without regenerating speech.

The app labels fixture output exactly **Demonstration replay** and states that it is not live provider output. The replay still uses CueBench’s real durable lease, staged adoption, caption revisions, validation, and Court Record path. It deliberately cannot Sustain, Object, or certify its own proposals.
