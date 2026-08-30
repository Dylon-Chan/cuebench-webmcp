import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createProject,
  prepareTrackExport,
  type CaptionProject,
  type CertificationReadiness,
  type CommandResult,
  type ProjectTrackExport,
  type QualityFinding,
} from "@cuebench/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CertificationReview } from "./CertificationReview";
import { ExportDialog } from "./ExportDialog";
import { ImpactSummaryPanel } from "./ImpactSummaryPanel";
import { ProfileProposalDialog } from "./ProfileProposalDialog";
import { ValidationPanel } from "./ValidationPanel";

const human = { type: "Human" as const, id: "human" };

const projectFixture = (): CaptionProject => createProject({
  projectId: "certification-ui",
  title: "Gibbs free energy lesson",
  media: {
    sourceId: "lesson-video",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "c01",
    state: "Proposed",
    startMs: 1_000,
    endMs: 3_000,
    text: "Dr. Nguyen introduces Gibbs free energy.",
    speaker: "Dr. Nguyen",
    actor: { type: "CueBenchAI", id: "cuebench-ai" },
    cause: "fixture",
  }],
});

const blocker: QualityFinding = {
  id: "fixture-blocker",
  findingId: "fixture-blocker",
  ruleId: "caption-timing",
  severity: "blocker",
  message: "The caption timing overlaps a protected region.",
  target: { type: "project", projectId: "certification-ui", projectRevision: 1 },
};

const warning: QualityFinding = {
  id: "fixture-warning",
  findingId: "fixture-warning",
  ruleId: "reading-speed",
  severity: "warning",
  message: "The reading speed needs a human decision.",
  target: { type: "project", projectId: "certification-ui", projectRevision: 1 },
};

const readiness = (overrides: Partial<CertificationReadiness> = {}): CertificationReadiness => ({
  readinessHash: `sha256:${"1".repeat(64)}`,
  canCertify: true,
  currentBlockers: [],
  unwaivedWarnings: [],
  staleValidationCauses: [],
  itemStateCounts: { Proposed: 0, AgentReady: 0, Objected: 0, Sustained: 1 },
  validationRun: null,
  ...overrides,
});

const accepted = (project = projectFixture()): CommandResult => ({ project, events: [] });

const exportUrlApi = () => ({
  createObjectURL: vi.fn(() => "blob:cuebench:export-1"),
  revokeObjectURL: vi.fn(),
});

afterEach(() => cleanup());

describe("Certification and export human workflows", () => {
  it("keeps blocking validation findings distinct from review state and prevents certification", async () => {
    const project = projectFixture();
    render(
      <CertificationReview
        project={project}
        onCommand={async () => accepted(project)}
        prepareReadiness={() => readiness({
          canCertify: false,
          currentBlockers: [blocker],
          itemStateCounts: { Proposed: 1, AgentReady: 0, Objected: 0, Sustained: 0 },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review certification" }));
    const dialog = await screen.findByRole("dialog", { name: "Certification review" });
    expect(within(dialog).getByText("Blocking validation findings")).toBeVisible();
    expect(within(dialog).getByText(blocker.message)).toBeVisible();
    expect(within(dialog).getByText(/Proposed review items/i)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Confirm certification" })).toBeDisabled();
  });

  it("requires a reason and always sends a Human warning waiver", async () => {
    const project = projectFixture();
    const onCommand = vi.fn(async () => accepted(project));
    render(<ValidationPanel project={project} onCommand={onCommand} findings={[warning]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open validation" }));
    fireEvent.click(await screen.findByRole("button", { name: `Waive warning ${warning.findingId}` }));
    const dialog = await screen.findByRole("dialog", { name: "Waive quality warning" });
    const confirm = within(dialog).getByRole("button", { name: "Record Human waiver" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Reason for waiving this warning"), {
      target: { value: "The source speaker intentionally pauses for emphasis." },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: "The source speaker intentionally pauses for emphasis.",
    })));
  });

  it("renders a proposal as an immutable diff and applies it only with a Human command", async () => {
    const project = projectFixture();
    const onCommand = vi.fn(async () => accepted(project));
    render(
      <ProfileProposalDialog
        project={project}
        onCommand={onCommand}
        proposal={{
          proposalId: "proposal-reading-speed",
          createdBy: "Browser Agent",
          rationale: "The lecture uses intentionally dense technical terms.",
          profileId: project.qualityProfile.profileId,
          name: "Education Quality Profile — technical lecture",
          rules: {
            ...project.qualityProfile.rules,
            caption: { maxReadingSpeedCps: 22 },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review profile proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Quality profile proposal" });
    expect(within(dialog).getByText(/Browser Agent proposed/i)).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply proposed profile" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ApplyProfile",
      actor: human,
      profileId: project.qualityProfile.profileId,
      name: "Education Quality Profile — technical lecture",
    })));
  });

  it("supplies an honest built-in profile preset when no agent proposal inbox is configured", async () => {
    const project = projectFixture();
    const onCommand = vi.fn(async () => accepted(project));
    render(<ProfileProposalDialog project={project} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "Review profile proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Quality profile proposal" });
    expect(within(dialog).getAllByText(/CueBench built-in preset/i)[0]).toBeVisible();
    expect(within(dialog).getByText(/not a compliance claim/i)).toBeVisible();
    expect(within(dialog).getByText("rules.caption.maxReadingSpeedCps")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply proposed profile" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ApplyProfile",
      actor: human,
    })));
  });

  it("refreshes a stale readiness hash immediately before the human confirmation", async () => {
    const project = projectFixture();
    const first = readiness({ readinessHash: `sha256:${"1".repeat(64)}` });
    const second = readiness({ readinessHash: `sha256:${"2".repeat(64)}` });
    const prepareReadiness = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValue(second);
    const onCommand = vi.fn(async () => accepted(project));
    render(
      <CertificationReview
        project={project}
        onCommand={onCommand}
        prepareReadiness={prepareReadiness}
        now={() => 1_700_000_000_000}
        createCertificationId={() => "certification-fixture"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review certification" }));
    const dialog = await screen.findByRole("dialog", { name: "Certification review" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm certification" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Certification readiness changed");
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm certification" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "CertifyProject",
      actor: human,
      expectedReadinessHash: second.readinessHash,
      certificationId: "certification-fixture",
      certifiedAtMs: 1_700_000_000_000,
    })));
  });

  it("creates an object URL only after verified draft export and labels the filename", async () => {
    const project = projectFixture();
    const urlApi = exportUrlApi();
    const onCommand = vi.fn(async () => accepted(project));
    render(<ExportDialog project={project} onCommand={onCommand} urlApi={urlApi} now={() => 1_700_000_000_000} createExportId={() => "draft-export"} />);

    fireEvent.click(screen.getByRole("button", { name: "Export tracks" }));
    const dialog = await screen.findByRole("dialog", { name: "Export track" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare verified download" }));

    const download = await within(dialog).findByRole("link", { name: "Download verified export" });
    expect(download).toHaveAttribute("download", "gibbs-free-energy-lesson.draft.vtt");
    expect(urlApi.createObjectURL).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "RecordExportRoundTrip",
      actor: { type: "System", id: "cuebench-export" },
      disposition: "draft",
    }));
  });

  it("revokes and suppresses a stale export URL when the project revision changes while preparation is in flight", async () => {
    const project = projectFixture();
    const urlApi = exportUrlApi();
    let resolvePrepared!: (value: ProjectTrackExport) => void;
    const pendingPrepared = new Promise<ProjectTrackExport>((resolve) => { resolvePrepared = resolve; });
    const prepareExport = vi.fn(() => pendingPrepared);
    const onCommand = vi.fn(async () => accepted(project));
    const view = render(<ExportDialog project={project} onCommand={onCommand} urlApi={urlApi} prepareExport={prepareExport} />);

    fireEvent.click(screen.getByRole("button", { name: "Export tracks" }));
    const dialog = await screen.findByRole("dialog", { name: "Export track" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare verified download" }));
    view.rerender(<ExportDialog project={{ ...project, projectRevision: project.projectRevision + 1 }} onCommand={onCommand} urlApi={urlApi} prepareExport={prepareExport} />);
    resolvePrepared(prepareTrackExport({ project, trackKind: "Captions", format: "vtt", disposition: "draft" }));

    await waitFor(() => expect(prepareExport).toHaveBeenCalledTimes(1));
    expect(onCommand).not.toHaveBeenCalled();
    expect(urlApi.createObjectURL).not.toHaveBeenCalled();
  });

  it("uses the certified filename label and blocks a mismatch before any download URL exists", async () => {
    const project = projectFixture();
    const urlApi = exportUrlApi();
    const prepared = prepareTrackExport({ project, trackKind: "Captions", format: "vtt", disposition: "draft" });
    const certifiedExport: ProjectTrackExport = { ...prepared, filename: "gibbs-free-energy-lesson.certified.vtt" };
    const onCommand = vi.fn(async () => accepted(project));
    const prepareExport = vi.fn(() => certifiedExport);
    render(<ExportDialog project={project} onCommand={onCommand} urlApi={urlApi} prepareExport={prepareExport} />);

    fireEvent.click(screen.getByRole("button", { name: "Export tracks" }));
    const dialog = await screen.findByRole("dialog", { name: "Export track" });
    fireEvent.change(within(dialog).getByLabelText("Export version"), { target: { value: "certified" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare verified download" }));
    expect((await within(dialog).findByRole("link", { name: "Download verified export" }))).toHaveAttribute("download", "gibbs-free-energy-lesson.certified.vtt");

    cleanup();
    const mismatchUrlApi = exportUrlApi();
    render(
      <ExportDialog
        project={project}
        onCommand={onCommand}
        urlApi={mismatchUrlApi}
        prepareExport={() => { throw new Error("Serialized track differs at item 1 field text."); }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export tracks" }));
    const mismatchDialog = await screen.findByRole("dialog", { name: "Export track" });
    fireEvent.click(within(mismatchDialog).getByRole("button", { name: "Prepare verified download" }));
    expect(await within(mismatchDialog).findByRole("alert")).toHaveTextContent("Serialized track differs");
    expect(mismatchUrlApi.createObjectURL).not.toHaveBeenCalled();
  });

  it("renders only project-local impact fields without estimates or compliance claims", () => {
    render(<ImpactSummaryPanel project={projectFixture()} />);

    expect(screen.getByRole("region", { name: "Project impact summary" })).toHaveTextContent("Initial findings");
    expect(screen.getByText("Human interventions")).toBeVisible();
    expect(screen.queryByText(/estimated time saved|compliance score|WCAG certified/i)).not.toBeInTheDocument();
  });
});
