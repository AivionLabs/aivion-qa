import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Page } from "playwright";

export interface ScreenshotDiffOptions {
  /** Baseline file path (relative or absolute). Created on first run. */
  baselinePath: string;
  /** Where to write the actual + diff PNGs when there's a mismatch. */
  artifactsDir: string;
  /** 0 = strict, 1 = match anything. Playwright default ~0.2 is sane. */
  threshold?: number;
  /** Optional CSS selector to screenshot a specific element (else fullPage). */
  selector?: string;
  /** When true, write the current screenshot AS the baseline and pass. */
  updateBaseline?: boolean;
}

export interface ScreenshotDiffResult {
  pass: boolean;
  detail: string;
  artifacts?: { actual?: string; diff?: string; baseline?: string };
}

export async function screenshotDiff(
  page: Page,
  opts: ScreenshotDiffOptions,
): Promise<ScreenshotDiffResult> {
  const threshold = opts.threshold ?? 0.2;

  const buffer = opts.selector
    ? await page.locator(opts.selector).screenshot()
    : await page.screenshot({ fullPage: false });

  // First run, OR explicit update — write baseline, pass.
  if (!existsSync(opts.baselinePath) || opts.updateBaseline) {
    mkdirSync(dirname(opts.baselinePath), { recursive: true });
    writeFileSync(opts.baselinePath, buffer);
    return {
      pass: true,
      detail: existsSync(opts.baselinePath)
        ? `Baseline updated: ${opts.baselinePath}`
        : `Baseline created: ${opts.baselinePath}`,
    };
  }

  const baseline = PNG.sync.read(readFileSync(opts.baselinePath));
  const actual = PNG.sync.read(buffer);

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return saveArtifactsAndFail(opts.artifactsDir, opts.baselinePath, buffer, null,
      `Size mismatch — baseline ${baseline.width}x${baseline.height}, actual ${actual.width}x${actual.height}`);
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(
    baseline.data, actual.data, diff.data,
    baseline.width, baseline.height,
    { threshold },
  );

  const totalPixels = baseline.width * baseline.height;
  const ratio = diffPixels / totalPixels;
  const allowedRatio = 0.001; // <0.1% pixel diff = pass

  if (ratio <= allowedRatio) {
    return { pass: true, detail: `${diffPixels} px differ (${(ratio * 100).toFixed(3)}%)` };
  }

  return saveArtifactsAndFail(opts.artifactsDir, opts.baselinePath, buffer, diff,
    `${diffPixels} px differ (${(ratio * 100).toFixed(3)}% > ${(allowedRatio * 100).toFixed(3)}%)`);
}

function saveArtifactsAndFail(
  artifactsDir: string,
  baselinePath: string,
  actualBuffer: Buffer,
  diff: PNG | null,
  detail: string,
): ScreenshotDiffResult {
  mkdirSync(artifactsDir, { recursive: true });
  const stem = baselinePath.split("/").pop()?.replace(/\.png$/, "") ?? "screenshot";
  const actualPath = join(artifactsDir, `${stem}.actual.png`);
  writeFileSync(actualPath, actualBuffer);
  const artifacts: { actual?: string; diff?: string; baseline?: string } = {
    actual: actualPath, baseline: baselinePath,
  };
  if (diff) {
    const diffPath = join(artifactsDir, `${stem}.diff.png`);
    writeFileSync(diffPath, PNG.sync.write(diff));
    artifacts.diff = diffPath;
  }
  return { pass: false, detail, artifacts };
}
