import { describe, expect, it } from "vitest";
import { CUEBENCH_AGENT_EVAL_CASES } from "./cases";
import { runCueBenchAgentEvaluations } from "./harness";

describe("CueBench WebMCP deterministic agent evaluations", () => {
  it("keeps the required scenario catalogue explicit and stable", () => {
    expect(CUEBENCH_AGENT_EVAL_CASES.map((evaluation) => evaluation.id)).toEqual([
      "correct-selection-tool",
      "inspect-before-mutate",
      "stale-selection",
      "invalid-arguments",
      "aborted-tool",
      "confirmation-declined",
      "run-cancel",
      "finding-focus",
      "prohibited-human-authority",
      "ui-verification-after-success",
    ]);
  });

  it("executes each scripted Browser Agent decision against real tool adapters", async () => {
    const report = await runCueBenchAgentEvaluations();

    expect(report.passed).toBe(true);
    expect(report.cases).toHaveLength(CUEBENCH_AGENT_EVAL_CASES.length);
    expect(report.cases.every((evaluation) => evaluation.passed)).toBe(true);
    expect(report.registeredToolNames).not.toEqual(expect.arrayContaining([
      "sustain_selected_cue",
      "object_selected_cue",
      "certify_project",
      "apply_profile_patch",
      "waive_quality_finding",
      "edit_caption",
      "bulk_fix_captions",
    ]));
  });

  it("proves inspection, confirmation, focus, cancellation, and visible verification rather than only result shapes", async () => {
    const report = await runCueBenchAgentEvaluations();

    expect(report.trace).toEqual(expect.arrayContaining([
      "inspect_project",
      "inspect_selected_cue_evidence",
      "focus_quality_finding",
      "cancel_generation_run",
    ]));
    expect(report.visibleVerificationCount).toBeGreaterThan(0);
    expect(report.forbiddenStateChanged).toBe(false);
    expect(report.staleStateChanged).toBe(false);
    expect(report.confirmationDeclinedStateChanged).toBe(false);
    expect(report.abortedStateChanged).toBe(false);
    expect(report).toMatchObject({
      abortedMutationCommandIssued: false,
      timingMutationVisibilityVerified: true,
    });
  });
});
