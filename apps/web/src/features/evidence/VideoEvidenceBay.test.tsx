import { fireEvent, render, screen } from "@testing-library/react";
import { createProject } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import { projectMediaEvidence, type PreparedMediaEvidence } from "./project-media-evidence";
import { VideoEvidenceBay } from "./VideoEvidenceBay";

const evidenceProject = (title = "Uploaded lesson"): ReturnType<typeof createProject> => createProject({
  projectId: "evidence-project",
  title,
  media: {
    sourceId: "source-evidence",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
});

const acceptedCommand = (project: ReturnType<typeof createProject>) => vi.fn((command) => ({
  project,
  events: [],
  ...(command.type === "SelectItem" ? {} : {}),
}));

const renderEvidence = (evidence: PreparedMediaEvidence, title?: string) => {
  const project = evidenceProject(title);
  const onCommand = acceptedCommand(project);
  render(
    <VideoEvidenceBay
      project={project}
      sourceObjectUrl="blob:cuebench:source"
      evidence={evidence}
      onCommand={onCommand}
    />,
  );
  return { onCommand, project };
};

describe("VideoEvidenceBay", () => {
  it("keeps audio available by default and wires mute and volume controls to the native video", () => {
    renderEvidence({ audioState: "pending", peakPyramid: null });
    const video = screen.getByLabelText("Verified local source media") as HTMLVideoElement;
    const mute = screen.getByRole("button", { name: "Mute source audio" });
    const volume = screen.getByRole("slider", { name: "Source audio volume" }) as HTMLInputElement;

    expect(video).not.toHaveAttribute("muted");
    fireEvent.click(mute);
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute source audio" })).toBeVisible();

    fireEvent.change(volume, { target: { value: "0.35" } });
    expect(video.volume).toBeCloseTo(0.35);
  });

  it("uses one truthful prepared-evidence state message without locally decoding the entire source", () => {
    renderEvidence({ audioState: "no-audio", peakPyramid: null }, "CueBench bundled media fixture");

    expect(screen.getByTestId("media-evidence-status")).toHaveTextContent("No audio track in this source.");
    expect(screen.queryByText(/waveform pending/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/audio peak evidence is unavailable/i)).not.toBeInTheDocument();
  });

  it("distinguishes pending prepared evidence from an evidence preparation failure", () => {
    const { rerender } = render(
      <VideoEvidenceBay
        project={evidenceProject()}
        sourceObjectUrl="blob:cuebench:source"
        evidence={{ audioState: "pending", peakPyramid: null }}
        onCommand={acceptedCommand(evidenceProject())}
      />,
    );

    expect(screen.getByTestId("media-evidence-status")).toHaveTextContent("Waveform pending local evidence preparation.");
    rerender(
      <VideoEvidenceBay
        project={evidenceProject()}
        sourceObjectUrl="blob:cuebench:source"
        evidence={{ audioState: "failed", peakPyramid: null, failureMessage: "Audio decode did not complete." }}
        onCommand={acceptedCommand(evidenceProject())}
      />,
    );
    expect(screen.getByTestId("media-evidence-status")).toHaveTextContent("Waveform evidence preparation failed: Audio decode did not complete.");
  });

  it("uses trusted source provenance instead of a project title to decide audio presence", () => {
    expect(projectMediaEvidence({ sourceKind: "bundled-fixture", audioPresence: "absent" }).audioState).toBe("no-audio");
    expect(projectMediaEvidence({ sourceKind: "bundled-fixture", audioPresence: "present" }).audioState).toBe("pending");
    expect(projectMediaEvidence({ sourceKind: "uploaded", audioPresence: "unknown" }).audioState).toBe("pending");
  });

  it("exposes the one native video clock for a semantic split control", () => {
    const onPlayheadReady = vi.fn();
    const project = evidenceProject();
    render(
      <VideoEvidenceBay
        project={project}
        sourceObjectUrl="blob:cuebench:source"
        evidence={{ audioState: "pending", peakPyramid: null }}
        onCommand={acceptedCommand(project)}
        onPlayheadReady={onPlayheadReady}
      />,
    );
    const video = screen.getByLabelText("Verified local source media") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 12.345 });

    const readNativePlayhead = onPlayheadReady.mock.calls[0]?.[0] as (() => number) | undefined;
    expect(readNativePlayhead).toBeTypeOf("function");
    expect(readNativePlayhead?.()).toBe(12_345);
  });
});
