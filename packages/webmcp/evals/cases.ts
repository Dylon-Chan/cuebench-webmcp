/**
 * These are deliberately scripted decisions, not natural-language snapshots.
 * They make the collaboration contract repeatable across browser builds and
 * demonstrate that WebMCP contributes selection-aware remediation rather than
 * an invisible media-processing shortcut.
 */
export interface CueBenchAgentEvalCase {
  readonly id:
    | "correct-selection-tool"
    | "inspect-before-mutate"
    | "stale-selection"
    | "invalid-arguments"
    | "aborted-tool"
    | "confirmation-declined"
    | "run-cancel"
    | "finding-focus"
    | "prohibited-human-authority"
    | "ui-verification-after-success";
  readonly intent: string;
}

export const CUEBENCH_AGENT_EVAL_CASES: readonly CueBenchAgentEvalCase[] = [
  {
    id: "correct-selection-tool",
    intent: "A selected caption cue exposes only its caption-scoped family.",
  },
  {
    id: "inspect-before-mutate",
    intent: "The agent inspects the selected evidence before making a timing change.",
  },
  {
    id: "stale-selection",
    intent: "A current tool rejects an obsolete selection revision without mutation.",
  },
  {
    id: "invalid-arguments",
    intent: "Schema-invalid timing input returns a structured domain error without mutation.",
  },
  {
    id: "aborted-tool",
    intent: "A tool from an aborted selection family cannot change the project.",
  },
  {
    id: "confirmation-declined",
    intent: "A consequential proposed-cue replacement remains unchanged when the Human declines.",
  },
  {
    id: "run-cancel",
    intent: "An active generation run replaces starters and can be visibly cancelled.",
  },
  {
    id: "finding-focus",
    intent: "A finding focus selects, seeks, reveals, and activates the applicable cue family.",
  },
  {
    id: "prohibited-human-authority",
    intent: "Sustain and certification remain absent and cannot change project state through WebMCP.",
  },
  {
    id: "ui-verification-after-success",
    intent: "Successful mutations wait for the visible surface and dynamic registrations to settle.",
  },
] as const;
