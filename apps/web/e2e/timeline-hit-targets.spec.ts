import { expect, test, type Page } from "@playwright/test";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface HitTargetGeometry {
  readonly width: number;
  readonly height: number;
  readonly center: Point;
}

interface FixtureGeometry {
  readonly firstSpan: { readonly left: number; readonly width: number };
  readonly secondSpan: { readonly left: number; readonly width: number };
  readonly bodies: Record<string, HitTargetGeometry>;
  readonly targets: Record<string, HitTargetGeometry>;
  readonly hits: Record<string, string | null>;
}

const installShortCueFixture = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document.querySelector("#timeline-hit-fixture")?.remove();
    const fixture = document.createElement("div");
    fixture.id = "timeline-hit-fixture";
    fixture.style.cssText = "position:fixed;z-index:9999;top:92px;left:0;width:900px;pointer-events:auto";
    fixture.innerHTML = `
      <div class="timeline-surface">
        <section class="timeline-lane timeline-lane--captions">
          <div class="timeline-lane__label"><h3>Captions</h3><span>2 cues</span></div>
          <ol class="timeline-lane__items" aria-label="Short cue timing controls">
            <li class="timeline-item timeline-item--caption" data-fixture-item="c1" style="left:100px;width:10px">
              <button class="timeline-item__body" type="button" data-hit="c1-body">C1</button>
              <button class="timeline-item__handle timeline-item__handle--start" type="button" data-hit="c1-start"></button>
              <button class="timeline-item__handle timeline-item__handle--end" type="button" data-hit="c1-end"></button>
            </li>
            <li class="timeline-item timeline-item--caption" data-fixture-item="c2" style="left:110px;width:10px">
              <button class="timeline-item__body" type="button" data-hit="c2-body">C2</button>
              <button class="timeline-item__handle timeline-item__handle--start" type="button" data-hit="c2-start"></button>
              <button class="timeline-item__handle timeline-item__handle--end" type="button" data-hit="c2-end"></button>
            </li>
          </ol>
        </section>
      </div>
    `;
    fixture.querySelectorAll<HTMLButtonElement>("[data-hit]").forEach((button) => {
      button.addEventListener("click", () => document.documentElement.setAttribute("data-last-timeline-hit", button.dataset.hit ?? ""));
    });
    document.body.append(fixture);
  });
};

const readFixtureGeometry = async (page: Page): Promise<FixtureGeometry> => page.evaluate(() => {
  const target = (name: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(`[data-hit="${name}"]`);
    if (element === null) throw new Error(`Missing fixture target ${name}.`);
    return element;
  };
  const pseudoHitTarget = (name: string): HitTargetGeometry => {
    const element = target(name);
    const button = element.getBoundingClientRect();
    const pseudo = getComputedStyle(element, "::before");
    const width = Number.parseFloat(pseudo.width);
    const height = Number.parseFloat(pseudo.height);
    const left = button.left + Number.parseFloat(pseudo.left);
    const top = button.top + Number.parseFloat(pseudo.top);
    return { width, height, center: { x: left + width / 2, y: top + height / 2 } };
  };
  const bodyTarget = (name: string): HitTargetGeometry => {
    const box = target(name).getBoundingClientRect();
    return { width: box.width, height: box.height, center: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
  };
  const hitAt = (point: Point): string | null => document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("button")?.dataset.hit ?? null;
  const first = document.querySelector<HTMLElement>("[data-fixture-item=\"c1\"]")?.getBoundingClientRect();
  const second = document.querySelector<HTMLElement>("[data-fixture-item=\"c2\"]")?.getBoundingClientRect();
  if (first === undefined || second === undefined) throw new Error("Missing short cue spans.");
  const targets = {
    "c1-start": pseudoHitTarget("c1-start"),
    "c1-end": pseudoHitTarget("c1-end"),
    "c2-start": pseudoHitTarget("c2-start"),
    "c2-end": pseudoHitTarget("c2-end"),
  };
  const bodies = {
    "c1-body": bodyTarget("c1-body"),
    "c2-body": bodyTarget("c2-body"),
  };
  const points = {
    ...Object.fromEntries(Object.entries(bodies).map(([name, geometry]) => [name, geometry.center])),
    ...Object.fromEntries(Object.entries(targets).map(([name, geometry]) => [name, geometry.center])),
  };
  return {
    firstSpan: { left: first.left, width: first.width },
    secondSpan: { left: second.left, width: second.width },
    bodies,
    targets,
    hits: Object.fromEntries(Object.entries(points).map(([name, point]) => [name, hitAt(point)])),
  };
});

test("short adjacent timeline spans retain body selection and separated reachable handle targets", async ({ page }) => {
  for (const { viewport, minimumTarget } of [
    { viewport: { width: 1536, height: 1024 }, minimumTarget: 24 },
    { viewport: { width: 320, height: 720 }, minimumTarget: 44 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await installShortCueFixture(page);
    const geometry = await readFixtureGeometry(page);

    expect(geometry.firstSpan.width).toBe(10);
    expect(geometry.secondSpan.left).toBe(geometry.firstSpan.left + geometry.firstSpan.width);
    expect(geometry.bodies["c1-body"]?.width).toBeGreaterThan(0);
    expect(geometry.bodies["c1-body"]?.width).toBeLessThanOrEqual(geometry.firstSpan.width);
    expect(geometry.bodies["c2-body"]?.width).toBeGreaterThan(0);
    expect(geometry.bodies["c2-body"]?.width).toBeLessThanOrEqual(geometry.secondSpan.width);
    expect(geometry.hits).toEqual({
      "c1-body": "c1-body",
      "c2-body": "c2-body",
      "c1-start": "c1-start",
      "c1-end": "c1-end",
      "c2-start": "c2-start",
      "c2-end": "c2-end",
    });
    for (const target of Object.values(geometry.targets)) {
      expect(target.width).toBeGreaterThanOrEqual(minimumTarget);
      expect(target.height).toBeGreaterThanOrEqual(minimumTarget);
    }

    for (const [name, point] of Object.entries({
      ...Object.fromEntries(Object.entries(geometry.bodies).map(([target, details]) => [target, details.center])),
      ...Object.fromEntries(Object.entries(geometry.targets).map(([target, details]) => [target, details.center])),
    })) {
      await page.mouse.click(point.x, point.y);
      await expect(page.locator("html")).toHaveAttribute("data-last-timeline-hit", name);
    }
  }
});
