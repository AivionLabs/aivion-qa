import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { QaConfig } from "../types.js";
import { callAi } from "../ai/caller.js";
import { aiCheckResultSchema } from "../schemas.js";
import { getDomSnapshot } from "./browser.js";

export interface AiCheckResult {
  pass: boolean;
  reason: string;
}

const DOM_TRUNCATE_CHARS = 8000;

export async function runAiCheck(
  page: Page,
  assertion: string,
  includeScreenshot: boolean,
  config: QaConfig,
  screenshotDir?: string,
): Promise<AiCheckResult> {
  const dom = await getDomSnapshot(page);
  const truncated = dom.length > DOM_TRUNCATE_CHARS;
  const domForPrompt = dom.slice(0, DOM_TRUNCATE_CHARS);

  let imageBase64: string | undefined;
  let imageMimeType: string | undefined;

  if (includeScreenshot) {
    // Take screenshot directly into a buffer; optionally persist for the report.
    const buffer = await page.screenshot({ fullPage: false });
    imageBase64 = buffer.toString("base64");
    imageMimeType = "image/png";

    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      writeFileSync(join(screenshotDir, `ai_check_${Date.now()}.png`), buffer);
    }
  }

  const systemPrompt = `You are a QA assertion evaluator. Given a DOM snapshot${includeScreenshot ? " and screenshot" : ""}, decide if the assertion is satisfied.
Return JSON: { "pass": boolean, "reason": string }
- pass: true if satisfied, false otherwise.
- reason: one sentence explaining your decision.`;

  const userPrompt = `Assertion: ${assertion}

DOM snapshot${truncated ? ` (truncated to first ${DOM_TRUNCATE_CHARS} chars of ${dom.length})` : ""}:
${domForPrompt}`;

  const result = await callAi<AiCheckResult>({
    config: config.ai,
    task: "ai_check",
    systemPrompt,
    userPrompt,
    schema: aiCheckResultSchema,
    imageBase64,
    imageMimeType,
  });

  return result.data;
}
