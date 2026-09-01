import { expect, test } from "./fixtures/test";
import {
  installFakeModelContext,
  invokeWebMcp,
  waitForWebMcpTool,
  webMcpToolNames,
} from "./fixtures/fake-model-context";
import { installDurableStorage, openGibbsLesson, runDemonstrationReplay } from "./fixtures/workbench";

interface InspectProjectResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: {
    readonly project: {
      readonly selectedItem: {
        readonly kind: string;
        readonly selectionId: string;
        readonly selectionRevision: number;
      } | null;
    };
  };
}

interface FindingSummary {
  readonly findingId: string;
  readonly ruleId: string;
  readonly targetItemIds: readonly string[];
}

interface FindingListResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: { readonly findings: readonly FindingSummary[] };
}

interface FocusFindingResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: {
    readonly selection: {
      readonly selectionId: string;
      readonly selectionRevision: number;
    };
  };
}

interface GapEvidenceResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: {
    readonly gap: { readonly gapId: string; readonly gapRevision: number };
  };
}

interface ValidationResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: { readonly validation: unknown };
}

interface CertificationReadinessResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: {
    readonly readiness: {
      readonly canCertify: boolean;
      readonly blockerCount: number;
      readonly unwaivedWarningCount: number;
    };
  };
}

interface ExportResult {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly data: {
    readonly export: {
      readonly published: boolean;
      readonly trackKind: string;
      readonly format: string;
      readonly disposition: string;
    };
  };
}

const humanAuthorityToolNames = [
  "sustain_selected_cue",
  "object_selected_cue",
  "sustain_selected_ad",
  "object_selected_ad",
  "waive_quality_finding",
  "apply_profile_patch",
  "verify_item_evidence",
  "certify_project",
] as const;

const expectHumanAuthorityAbsent = async (page: Parameters<typeof webMcpToolNames>[0]) => {
  const names = await webMcpToolNames(page);
  for (const forbidden of humanAuthorityToolNames) expect(names, `${forbidden} must remain Human-only`).not.toContain(forbidden);
};

const inspectProject = (page: Parameters<typeof invokeWebMcp>[0]) => invokeWebMcp<InspectProjectResult>(
  page,
  "inspect_project",
  { contractVersion: 1 },
);

test("a Browser Agent remediates the live timeline while Human authority stays in the page", async ({ page }) => {
  test.setTimeout(90_000);
  await installFakeModelContext(page);
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await waitForWebMcpTool(page, "inspect_project");
  await expectHumanAuthorityAbsent(page);
  await runDemonstrationReplay(page);

  const inspected = await inspectProject(page);
  expect(inspected.ok).toBe(true);
  const listed = await invokeWebMcp<FindingListResult>(page, "list_quality_findings", {
    contractVersion: 1,
    expectedProjectRevision: inspected.projectRevision,
    limit: 24,
  });
  const properNameFinding = listed.data.findings.find((finding) => (
    finding.targetItemIds.includes("gibbs-cue-01")
    && finding.ruleId === "review.unreviewed-revision"
  ));
  const targetRevisionFinding = listed.data.findings.find((finding) => (
    finding.targetItemIds.includes("gibbs-cue-05")
    && finding.ruleId === "review.unreviewed-revision"
  ));
  expect(properNameFinding).toBeDefined();
  expect(targetRevisionFinding).toBeDefined();

  const focusedName = await invokeWebMcp<FocusFindingResult>(page, "focus_quality_finding", {
    contractVersion: 1,
    expectedProjectRevision: listed.projectRevision,
    findingId: properNameFinding!.findingId,
  });
  expect(focusedName).toMatchObject({ ok: true, data: { selection: { selectionId: "gibbs-cue-01" } } });
  await waitForWebMcpTool(page, "inspect_selected_cue_evidence");
  await expect(page.getByRole("button", { name: /Select Caption GIBBS-CUE-01/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Selected Caption GIBBS-CUE-01" })).toBeVisible();
  await expect(page.getByText(/Original transcript:\s*Nguyen\./u)).toBeVisible();

  const afterNameFocus = await inspectProject(page);
  const focusedTarget = await invokeWebMcp<FocusFindingResult>(page, "focus_quality_finding", {
    contractVersion: 1,
    expectedProjectRevision: afterNameFocus.projectRevision,
    findingId: targetRevisionFinding!.findingId,
  });
  expect(focusedTarget).toMatchObject({ ok: true, data: { selection: { selectionId: "gibbs-cue-05" } } });
  await expect(page.getByRole("heading", { name: "Selected Caption GIBBS-CUE-05" })).toBeVisible();

  const revisionPromise = invokeWebMcp<{
    readonly ok: boolean;
    readonly projectRevision: number;
    readonly data: { readonly cue: { readonly itemId: string; readonly itemRevision: number; readonly state: string } };
  }>(page, "revise_selected_cue", {
    contractVersion: 1,
    expectedProjectRevision: focusedTarget.projectRevision,
    expectedSelectionId: focusedTarget.data.selection.selectionId,
    expectedSelectionRevision: focusedTarget.data.selection.selectionRevision,
    expectedItemRevision: focusedTarget.data.selection.selectionRevision,
    text: "When delta G is negative, the change favors products.",
  });
  const confirmation = page.getByRole("dialog", { name: "Replace these proposals?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm Browser Agent change" }).click();
  const revised = await revisionPromise;
  expect(revised).toMatchObject({
    ok: true,
    data: { cue: { itemId: "gibbs-cue-05", itemRevision: 2, state: "Proposed" } },
  });
  await expect(page.getByRole("textbox", { name: "Caption text for GIBBS-CUE-05" })).toHaveValue(
    "When delta G is negative, the change favors products.",
  );
  await expectHumanAuthorityAbsent(page);

  await page.getByRole("button", { name: "Sustain selected revision" }).click();
  await expect(page.getByText("Sustained Caption GIBBS-CUE-05 as a Human ruling.")).toBeVisible();
  await page.getByRole("button", { name: "Verify retained evidence for selected revision" }).click();
  await expect(page.getByText(/Verified retained evidence for Caption GIBBS-CUE-05 r3\./u)).toBeVisible();
  await expectHumanAuthorityAbsent(page);

  await page.getByRole("button", { name: "Select audio-description gap GIBBS-DIAGRAM-GAP" }).click();
  await waitForWebMcpTool(page, "inspect_selected_gap_evidence");
  const gapProject = await inspectProject(page);
  expect(gapProject.data.project.selectedItem).toMatchObject({
    kind: "AudioDescriptionGap",
    selectionId: "gibbs-diagram-gap",
  });
  const selectedGap = gapProject.data.project.selectedItem!;
  const gapContext = await invokeWebMcp<GapEvidenceResult>(page, "inspect_selected_gap_evidence", {
    contractVersion: 1,
    expectedProjectRevision: gapProject.projectRevision,
    expectedSelectionId: selectedGap.selectionId,
    expectedSelectionRevision: selectedGap.selectionRevision,
    expectedGapRevision: selectedGap.selectionRevision,
  });
  expect(gapContext.ok).toBe(true);

  const proposed = await invokeWebMcp<{
    readonly ok: boolean;
    readonly data: { readonly beat: { readonly itemId: string; readonly itemRevision: number; readonly state: string } };
  }>(page, "propose_ad_beat_in_gap", {
    contractVersion: 1,
    expectedProjectRevision: gapContext.projectRevision,
    expectedSelectionId: gapContext.data.gap.gapId,
    expectedSelectionRevision: gapContext.data.gap.gapRevision,
    expectedGapRevision: gapContext.data.gap.gapRevision,
    startMs: 52_000,
    endMs: 62_000,
    description: "A reaction-progress curve climbs to a crest, then settles lower as an arrow marks delta G.",
  });
  expect(proposed).toMatchObject({ ok: true, data: { beat: { itemRevision: 1, state: "Proposed" } } });
  await waitForWebMcpTool(page, "inspect_selected_ad_evidence");
  await expect(page.getByRole("textbox", {
    name: `Audio-description text for ${proposed.data.beat.itemId.toUpperCase()}`,
  })).toHaveValue("A reaction-progress curve climbs to a crest, then settles lower as an arrow marks delta G.");
  await expectHumanAuthorityAbsent(page);

  await page.getByRole("button", { name: "Sustain selected revision" }).click();
  await expect(page.getByText(new RegExp(`Sustained Audio description ${proposed.data.beat.itemId.toUpperCase()} as a Human ruling\\.`))).toBeVisible();

  const beforeValidation = await inspectProject(page);
  const validated = await invokeWebMcp<ValidationResult>(page, "validate_project", {
    contractVersion: 1,
    expectedProjectRevision: beforeValidation.projectRevision,
  });
  expect(validated).toMatchObject({ ok: true, data: { validation: expect.any(Object) } });
  await expectHumanAuthorityAbsent(page);

  const blockedReadiness = await invokeWebMcp<CertificationReadinessResult>(page, "prepare_certification_review", {
    contractVersion: 1,
    expectedProjectRevision: validated.projectRevision,
  });
  expect(blockedReadiness.ok).toBe(true);
  expect(blockedReadiness.data.readiness).toMatchObject({ canCertify: false, blockerCount: 0 });
  expect(blockedReadiness.data.readiness.unwaivedWarningCount).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open validation" }).click();
  const validationDialog = page.getByRole("dialog", { name: "Validation" });
  const waiverButtons = validationDialog.getByRole("button", { name: /^Waive warning /u });
  while (await waiverButtons.count() > 0) {
    const previousCount = await waiverButtons.count();
    await waiverButtons.first().click();
    const waiverDialog = page.getByRole("dialog", { name: "Waive quality warning" });
    await waiverDialog
      .getByRole("textbox", { name: "Reason for waiving this warning" })
      .fill("Human reviewed this Browser Agent remediation against the bundled source video.");
    await waiverDialog.getByRole("button", { name: "Record Human waiver" }).click();
    await expect(waiverDialog).toBeHidden();
    await expect(waiverButtons).toHaveCount(previousCount - 1);
  }
  await validationDialog.getByRole("button", { name: "Close validation" }).click();

  const afterWaivers = await inspectProject(page);
  const ready = await invokeWebMcp<CertificationReadinessResult>(page, "prepare_certification_review", {
    contractVersion: 1,
    expectedProjectRevision: afterWaivers.projectRevision,
  });
  expect(ready).toMatchObject({
    ok: true,
    data: { readiness: { canCertify: true, blockerCount: 0, unwaivedWarningCount: 0 } },
  });
  await expectHumanAuthorityAbsent(page);

  await page.getByRole("button", { name: "Review certification" }).click();
  const certificationDialog = page.getByRole("dialog", { name: "Certification review" });
  await certificationDialog.getByRole("button", { name: "Confirm certification" }).click();
  await expect(certificationDialog.getByRole("status")).toHaveText("Human certification recorded for the exact reviewed snapshot.");
  await certificationDialog.getByRole("button", { name: "Close" }).click();
  await expectHumanAuthorityAbsent(page);

  const certifiedProject = await inspectProject(page);
  const exported = await invokeWebMcp<ExportResult>(page, "export_track", {
    contractVersion: 1,
    expectedProjectRevision: certifiedProject.projectRevision,
    trackKind: "Captions",
    format: "vtt",
    disposition: "certified",
  });
  expect(exported).toMatchObject({
    ok: true,
    data: { export: { published: true, trackKind: "Captions", format: "vtt", disposition: "certified" } },
  });
  await expect(page.getByRole("link", { name: /Download .*\.certified\.vtt$/u })).toBeVisible();

  const showAll = page.getByRole("button", { name: /^Show all \d+$/u });
  if (await showAll.isVisible()) await showAll.click();
  await expect(page.getByRole("button", { name: "Filter Court Record to Browser Agent · browser-agent" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Court Record to Human · human" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Court Record to System · cuebench-validation" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Court Record to System · cuebench-export" }).first()).toBeVisible();
});
