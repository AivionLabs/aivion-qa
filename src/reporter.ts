import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunReport, QaConfig, IR } from "./types.js";
import { callAi } from "./ai/caller.js";

export async function writeReport(
  report: RunReport,
  ir: IR,
  reportDir: string,
  config: QaConfig,
): Promise<string> {
  // Generate AI summary before writing (empty string when ai.mode = off)
  const summary = await generateSummary(report, config);
  if (summary) report.aiSummary = summary;

  // Write ir.used.yaml snapshot
  writeFileSync(join(reportDir, "ir.used.json"), JSON.stringify(ir, null, 2));

  // Write markdown report
  const md = buildMarkdownReport(report);
  const reportPath = join(reportDir, "report.md");
  writeFileSync(reportPath, md);

  return reportPath;
}

function buildMarkdownReport(report: RunReport): string {
  const allPass = report.failed === 0;
  const status = allPass ? "PASS" : "FAIL";
  const emoji = allPass ? "✅" : "❌";

  const lines: string[] = [
    `# QA Report — ${report.planName}`,
    ``,
    `**Status:** ${emoji} ${status}  `,
    `**Run ID:** \`${report.runId}\`  `,
    `**Started:** ${report.startedAt}  `,
    `**Duration:** ${(report.durationMs / 1000).toFixed(1)}s  `,
    ``,
    `| Result | Count |`,
    `|--------|-------|`,
    `| ✅ Passed | ${report.passed} |`,
    `| ❌ Failed | ${report.failed} |`,
    `| ⊝ Skipped | ${report.skipped} |`,
    `| ~ Expected failures | ${report.expectedFailed} |`,
    ``,
  ];

  // Cases
  lines.push("## Test Cases", "");

  const realFails = report.cases.filter(c => c.status === "fail");
  const passes = report.cases.filter(c => c.status === "pass");
  const expectedFails = report.cases.filter(c => c.status === "expected_fail");

  if (realFails.length > 0) {
    lines.push("### Failed", "");
    for (const c of realFails) {
      lines.push(`#### ❌ ${c.id} — ${c.title}`);
      lines.push(`**Duration:** ${c.durationMs}ms  `);
      if (c.error) lines.push(`**Error:** ${c.error}  `);
      if (c.assertResults?.length) {
        lines.push("");
        lines.push("| Assert | Pass | Detail |");
        lines.push("|--------|------|--------|");
        for (const a of c.assertResults) {
          lines.push(`| \`${a.type}\` | ${a.pass ? "✅" : "❌"} | ${a.detail ?? ""} |`);
        }
      }
      if (c.screenshots?.length) {
        lines.push("");
        for (const ss of c.screenshots) {
          lines.push(`![screenshot](${ss})`);
        }
      }
      lines.push("");
    }
  }

  if (passes.length > 0) {
    lines.push("### Passed", "");
    lines.push("| ID | Title | Duration |");
    lines.push("|----|-------|----------|");
    for (const c of passes) {
      lines.push(`| ${c.id} | ${c.title} | ${c.durationMs}ms |`);
    }
    lines.push("");
  }

  if (expectedFails.length > 0) {
    lines.push("### Expected Failures (known bugs)", "");
    lines.push("These cases are tracked as known issues and do not affect the pass/fail status.", "");
    lines.push("| ID | Title | Bug |");
    lines.push("|----|-------|-----|");
    for (const c of expectedFails) {
      lines.push(`| ${c.id} | ${c.title} | ${c.expectedFail?.bug ?? "-"} |`);
    }
    lines.push("");
  }

  // AI Summary
  if (report.aiSummary) {
    lines.push("## AI Analysis", "");
    lines.push(report.aiSummary, "");
  }

  return lines.join("\n");
}

async function generateSummary(report: RunReport, config: QaConfig): Promise<string> {
  if (config.ai.mode === "off") return ""; // zero-LLM default

  const systemPrompt = `You are a QA analyst. Given a test run report, write a concise end-of-run analysis covering:
1. Overall health assessment (2-3 sentences)
2. Root cause hypotheses for any failures (be specific)
3. Flake likelihood — which failures look like timing/network issues vs real bugs
4. Suggested next steps for the developer

Keep it under 200 words. No preamble.`;

  const failSummary = report.cases
    .filter(c => c.status === "fail")
    .map(c => `- [FAIL] ${c.id} ${c.title}: ${c.error ?? "unknown error"}`)
    .join("\n");

  const userPrompt = `Plan: ${report.planName}
Run ID: ${report.runId}
Passed: ${report.passed} | Failed: ${report.failed} | Expected-fail: ${report.expectedFailed}

${failSummary || "All cases passed."}`;

  try {
    const result = await callAi<string>({
      config: config.ai,
      task: "summary",
      systemPrompt,
      userPrompt,
    });
    return typeof result.data === "string" ? result.data : result.rawText;
  } catch (err) {
    return `(AI summary unavailable: ${(err as Error).message})`;
  }
}

export function printReportSummary(report: RunReport): void {
  const allPass = report.failed === 0;
  console.log(`\n${"─".repeat(50)}`);
  console.log(allPass ? "PASS" : "FAIL");
  console.log(`  Passed:          ${report.passed}`);
  console.log(`  Failed:          ${report.failed}`);
  console.log(`  Skipped:         ${report.skipped}`);
  console.log(`  Expected-fail:   ${report.expectedFailed}`);
  console.log(`  Duration:        ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`${"─".repeat(50)}\n`);
}
