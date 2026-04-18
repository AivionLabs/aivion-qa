import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  IR, IRCase, IRAction, IRAssert, QaConfig, RunContext,
  CaseResult, AssertResult, RunReport,
} from "../types.js";
import { readFileSync, existsSync } from "node:fs";
import { createClerkAdapter } from "../adapters/auth/clerk.js";
import { createPostgresAdapter, pollUntil } from "../adapters/db/postgres.js";
import { buildFkGraph, computeDeleteOrder, buildUserScope, type FkGraph } from "../fk-graph.js";
import type { SchemaAnalysis, DbAdapter } from "../types.js";
import {
  launchBrowser, goto, click, fill, submit, waitFor,
  expectText, expectUrl, expectVisible, expectNotVisible, expectDisabled, expectAttribute,
  armDownloadWatcher, captureScreenshot, closeBrowser, watchNetwork,
  type BrowserSession,
} from "./browser.js";
import { httpRequest } from "./http.js";
import { runAiCheck } from "./ai-check.js";
import { resolve, resolveParams } from "./template.js";

// Synthetic context key; used to pass HTTP action state to http_status asserts.
const LAST_HTTP_STATUS = "__last_http_status";
// Note: plans should prefer `password: "QaTool-{run_id}-Run!"` in their
// meta.testUser so every run has a unique password (avoids HIBP blocks).
// This constant is only a fallback when the plan omits password entirely.
const DEFAULT_TEST_PASSWORD = "QaTool-Default-Run!";

export interface ExecuteOptions {
  ir: IR;
  config: QaConfig;
  reportsDir: string;
  qaToolDir: string;
  planName: string;
  failFast?: boolean;
  headless?: boolean;
}

export interface ExecuteResult {
  report: RunReport;
  reportDir: string;
  screenshotsDir: string;
}

export async function executeIr(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { ir, config, reportsDir, qaToolDir, planName, failFast = false, headless = true } = opts;

  const runId = generateRunId();
  const startedAt = new Date().toISOString();
  const reportDir = join(reportsDir, `${formatDate(new Date())}_${planName}`);
  const screenshotsDir = join(reportDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  // Substitute {run_id} in both email and password. Password uniqueness
  // matters: Clerk's frontend runs HIBP checks on every sign-in regardless
  // of skip_password_checks at creation. A run-unique password avoids
  // accidental collisions with breach lists.
  const meta = {
    ...ir.meta,
    runId,
    testUser: {
      ...ir.meta.testUser,
      email: ir.meta.testUser.email.replace(/\{run_id\}/g, runId),
      password: (ir.meta.testUser.password ?? DEFAULT_TEST_PASSWORD).replace(/\{run_id\}/g, runId),
    },
  };

  const ctx: RunContext = {
    runId,
    meta,
    context: {},
  };

  // Lazy FK graph loader (loaded on first schema-aware assert).
  let lazyGraph: FkGraph | undefined;
  const getGraph = (): FkGraph | undefined => {
    if (lazyGraph) return lazyGraph;
    const schemaPath = join(qaToolDir, "schema.json");
    if (!existsSync(schemaPath)) return undefined;
    const schema: SchemaAnalysis = JSON.parse(readFileSync(schemaPath, "utf8"));
    lazyGraph = buildFkGraph(schema);
    return lazyGraph;
  };
  (ctx as unknown as { getGraph: () => FkGraph | undefined }).getGraph = getGraph;

  const results: CaseResult[] = [];
  let browser: BrowserSession | undefined;

  console.log(`\nRun ID: ${runId}`);
  console.log(`Test user: ${meta.testUser.email}\n`);

  try {
    // ── Phase C.1: Prepare ───────────────────────────────────────────────────
    if (config.auth?.provider === "clerk") {
      ctx.auth = createClerkAdapter(config.auth.secretKeyEnv);
    }
    ctx.db = createPostgresAdapter(config.db.connectionStringEnv);

    // Auto cleanup (pre-run): wipe any leftover data for the test email so
    // reruns don't collide on FK/unique constraints. Runs BEFORE createUser
    // because creating a Clerk user would fail if the old one still exists.
    if (ir.setup?.cleanupUserData) {
      await cleanupUserData(ctx.db!, config, qaToolDir, meta.testUser.email, "pre-run");
      // Also remove the user from the auth provider if present.
      if (ctx.auth?.findUserByEmail) {
        const existing = await ctx.auth.findUserByEmail(meta.testUser.email);
        if (existing) {
          await ctx.auth.cleanup(existing.userId);
          console.log(`  Removed stale auth user ${existing.userId}`);
        }
      }
    }

    // Pre-create the test user only if the plan asks for it (login-first flows).
    // Signup flows leave setup.auth.createUser absent — the test drives /signup.
    let preCreatedUserId: string | undefined;
    if (ir.setup?.auth?.createUser && ctx.auth) {
      console.log("Creating test user (setup.auth.createUser)...");
      const credentials = await ctx.auth.createUser({
        email: meta.testUser.email,
        password: meta.testUser.password,
      });
      ctx.context["test_user_id"] = credentials.userId;
      preCreatedUserId = credentials.userId;
      console.log(`  Created: ${credentials.userId}`);
    }

    browser = await launchBrowser(headless);
    await browser.context.tracing.start({ screenshots: true, snapshots: true });

    // Determine sign-in mode. Default: "ui" if the user was pre-created,
    // otherwise "none" (the plan is expected to sign up / sign in itself).
    const signInMode = ir.setup?.signIn ?? (preCreatedUserId ? "ui" : "none");

    // Install auth plumbing (Clerk testing-token interception for bot bypass).
    if (ctx.auth) {
      await ctx.auth.applyToContext(browser.context);
    }

    if (ir.setup?.signInFlow && preCreatedUserId) {
      console.log("Signing in via custom setup.signInFlow...");
      for (const action of ir.setup.signInFlow) {
        await runAction(action, browser, ctx);
      }
      // Verify: we must actually leave any sign-in URL within 15s. Without
      // this, a silently-failing click looks like "signed in" but isn't.
      try {
        await browser.page.waitForURL(
          (url) => {
            const s = url.toString();
            return !s.includes("/sign-in") && !s.includes("/login") &&
                   !s.includes("accounts.dev");
          },
          { timeout: 15_000 },
        );
        console.log(`  Signed in → ${browser.page.url()}`);
      } catch {
        throw new Error(
          `signInFlow completed but browser is still on a sign-in URL: ${browser.page.url()}. ` +
          `The last action (e.g. click) likely didn't submit successfully, or credentials were rejected. ` +
          `Run node QA-Tools/debug-login.mjs to reproduce interactively.`,
        );
      }
    } else if (signInMode === "ui" && preCreatedUserId) {
      console.log("Signing in via /login UI...");
      const loginUrl = `${Object.values(meta.environments)[0] ?? "http://localhost:3000"}/login`;
      await goto(browser.page, loginUrl);

      try {
        await fillLoginForm(browser, meta.testUser.email, meta.testUser.password ?? DEFAULT_TEST_PASSWORD);
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\n\nTip: for multi-step or non-standard login flows, ` +
          `set setup.signInFlow in base.yaml with your exact actions. See PLAN_GUIDELINES.md §Login.`,
        );
      }
      await submit(browser.page);

      try {
        await browser.page.waitForURL(
          (url) => !url.toString().includes("/login") && !url.toString().includes("/sign-in"),
          { timeout: 15_000 },
        );
        console.log(`  Signed in → ${browser.page.url()}`);
      } catch {
        throw new Error(
          `Sign-in did not complete within 15s. Current URL: ${browser.page.url()}. ` +
          `For multi-step Clerk flows, set setup.signInFlow in base.yaml.`,
        );
      }
    } else if (signInMode === "ticket" && preCreatedUserId && ctx.auth?.signInViaToken) {
      console.log("Signing in via Clerk sign-in ticket...");
      try {
        await ctx.auth.signInViaToken(browser.page, preCreatedUserId);
        console.log(`  Signed in → ${browser.page.url()}`);
      } catch (err) {
        throw new Error(
          `Sign-in ticket activation failed: ${(err as Error).message}. ` +
          `Current URL: ${browser.page.url()}`,
        );
      }
    }

    // ── Phase C.2: Run cases ─────────────────────────────────────────────────
    // Hierarchy rules:
    //  1. The FIRST section is the foundation (signup/login). If any case in
    //     it fails, abort the whole run — everything downstream depends on it.
    //  2. Otherwise, section-level fail-fast: if any case in section N fails,
    //     skip the rest of section N but continue to the next section.
    let firstSection: string | undefined;
    let foundationFailed = false;
    const failedSections = new Set<string>();

    const allCases = ir.cases ?? [];
    for (const case_ of allCases) {
      const section = case_.id.split(".")[0] ?? "";
      if (firstSection === undefined) firstSection = section;

      if (foundationFailed) {
        const skipped: CaseResult = {
          id: case_.id, title: case_.title, status: "skip", durationMs: 0,
          error: `Aborted: foundation section ${firstSection} failed`,
        };
        results.push(skipped);
        console.log(`  [⊝] ${case_.id} ${case_.title} (aborted — section ${firstSection} failed)`);
        continue;
      }

      if (failedSections.has(section)) {
        const skipped: CaseResult = {
          id: case_.id, title: case_.title, status: "skip", durationMs: 0,
          error: `Skipped: earlier case in section ${section} failed`,
        };
        results.push(skipped);
        console.log(`  [⊝] ${case_.id} ${case_.title} (skipped — section ${section} failed earlier)`);
        continue;
      }

      const result = await runCase(case_, browser, ctx, config, screenshotsDir);
      results.push(result);

      const icon = result.status === "pass" ? "✓" :
                   result.status === "expected_fail" ? "~" : "✗";
      console.log(`  [${icon}] ${case_.id} ${case_.title} (${result.durationMs}ms)`);
      if (result.error) console.log(`      ${result.error}`);

      if (result.status === "fail") {
        failedSections.add(section);
        if (section === firstSection) {
          foundationFailed = true;
          console.log(`\n  Foundation section ${firstSection} failed — aborting remaining cases.`);
        }
      }

      if (failFast && result.status === "fail") {
        console.log("\nFail-fast: stopping after first failure.");
        break;
      }
    }
  } finally {
    // ── Phase C.3: Teardown ──────────────────────────────────────────────────
    if (browser) {
      try {
        await browser.context.tracing.stop({ path: join(reportDir, "trace.zip") });
      } catch { /* tracing may not have started */ }
      await closeBrowser(browser);
    }

    await runTeardown(ir, ctx, config, qaToolDir);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(startedAt).getTime();

  const passed = results.filter(r => r.status === "pass").length;
  const failed = results.filter(r => r.status === "fail").length;
  const expectedFailed = results.filter(r => r.status === "expected_fail").length;
  const skipped = results.filter(r => r.status === "skip").length;

  const report: RunReport = {
    planName,
    runId,
    startedAt,
    finishedAt,
    durationMs,
    passed,
    failed,
    expectedFailed,
    skipped,
    cases: results,
  };

  return { report, reportDir, screenshotsDir };
}

async function runCase(
  case_: IRCase,
  browser: BrowserSession,
  ctx: RunContext,
  config: QaConfig,
  screenshotsDir: string,
): Promise<CaseResult> {
  const start = Date.now();
  const screenshots: string[] = [];
  const assertResults: AssertResult[] = [];

  try {
    // Set up network + download watchers BEFORE any navigation so we can
    // catch events that fire during page load or on action triggers.
    const networkWatchers: Array<{ pattern: string; watcher: ReturnType<typeof watchNetwork> }> = [];
    let downloadWatcher: ReturnType<typeof armDownloadWatcher> | undefined;
    let downloadPattern: string | undefined;

    if (case_.asserts) {
      for (const assert of case_.asserts) {
        const a = assert as unknown as Record<string, unknown>;
        if (a.type === "no_network_call_matching" && typeof a.pattern === "string") {
          const watcher = watchNetwork(browser.page, resolve(a.pattern, ctx));
          networkWatchers.push({ pattern: a.pattern, watcher });
        }
        if (a.type === "expect_download" && !downloadWatcher) {
          downloadPattern = (a.filenamePattern as string | undefined) ?? (a.filename_pattern as string | undefined);
          downloadWatcher = armDownloadWatcher(browser.page, downloadPattern);
        }
      }
    }

    // Actions
    if (case_.actions) {
      for (const action of case_.actions) {
        await runAction(action, browser, ctx);
      }
    }

    // Evaluate network watchers
    for (const { pattern, watcher } of networkWatchers) {
      const matched = watcher.stop();
      const pass = matched.length === 0;
      assertResults.push({
        type: "no_network_call_matching",
        pass,
        detail: pass ? `No calls matched "${pattern}"` : `${matched.length} call(s) matched: ${matched.join(", ")}`,
      });
    }

    // Download watcher result
    if (downloadWatcher) {
      const { pass, actual } = await downloadWatcher.finish();
      assertResults.push({
        type: "expect_download",
        pass,
        detail: pass ? `Downloaded: ${actual}` :
          `No download captured${downloadPattern ? ` matching "${downloadPattern}"` : ""}`,
      });
    }

    // Asserts (other than no_network_call_matching + expect_download, already handled)
    if (case_.asserts) {
      for (const assert of case_.asserts) {
        const t = (assert as { type: string }).type;
        if (t === "no_network_call_matching" || t === "expect_download") continue;
        const result = await runAssert(assert, browser, ctx, config, screenshotsDir);
        assertResults.push(result);
      }
    }

    const allPass = assertResults.every(r => r.pass);

    if (!allPass && case_.expectedFail) {
      return {
        id: case_.id, title: case_.title, status: "expected_fail",
        durationMs: Date.now() - start, expectedFail: case_.expectedFail,
        screenshots, assertResults,
      };
    }

    // A case marked expectedFail that actually passes is suspicious — likely the
    // bug was fixed. Surface it as pass but flag via assertResults detail so the
    // reporter can optionally highlight it.
    if (allPass && case_.expectedFail) {
      assertResults.push({
        type: "expected_fail_passed",
        pass: true,
        detail: `Bug ${case_.expectedFail.bug} appears fixed — consider removing expected_fail marker.`,
      });
    }

    return {
      id: case_.id, title: case_.title,
      status: allPass ? "pass" : "fail",
      durationMs: Date.now() - start,
      error: allPass ? undefined : assertResults.filter(r => !r.pass).map(r => r.detail).filter(Boolean).join("; "),
      screenshots, assertResults,
    };

  } catch (err: unknown) {
    const error = (err as Error).message ?? String(err);

    try {
      const ssPath = join(screenshotsDir, `${case_.id}_fail_${Date.now()}.png`);
      await captureScreenshot(browser.page, ssPath);
      screenshots.push(ssPath);
    } catch { /* ignore screenshot errors */ }

    if (case_.expectedFail) {
      return {
        id: case_.id, title: case_.title, status: "expected_fail",
        durationMs: Date.now() - start, expectedFail: case_.expectedFail,
        screenshots, assertResults,
      };
    }

    return {
      id: case_.id, title: case_.title, status: "fail",
      durationMs: Date.now() - start, error,
      screenshots, assertResults,
    };
  }
}

async function runAction(action: IRAction, browser: BrowserSession, ctx: RunContext): Promise<void> {
  const raw = action as Record<string, unknown>;

  if ("browser.goto" in raw) {
    const url = resolve(raw["browser.goto"] as string, ctx);
    const fullUrl = url.startsWith("http")
      ? url
      : `${Object.values(ctx.meta.environments)[0] ?? "http://localhost:3000"}${url}`;
    await goto(browser.page, fullUrl);
    return;
  }

  if ("browser.click" in raw) {
    await click(browser.page, resolve(raw["browser.click"] as string, ctx));
    return;
  }

  if ("browser.fill" in raw) {
    const { selector, value } = raw["browser.fill"] as { selector: string; value: string };
    await fill(browser.page, resolve(selector, ctx), resolve(value, ctx));
    return;
  }

  if ("browser.fill_form" in raw) {
    await fillLoginForm(
      browser,
      ctx.meta.testUser.email,
      ctx.meta.testUser.password ?? DEFAULT_TEST_PASSWORD,
    );
    return;
  }

  if ("browser.submit" in raw) {
    await submit(browser.page);
    return;
  }

  if ("browser.wait_for" in raw) {
    await waitFor(browser.page, resolve(raw["browser.wait_for"] as string, ctx));
    return;
  }

  if ("browser.capture_url" in raw) {
    const spec = raw["browser.capture_url"] as { pattern: string; as: string };
    const currentUrl = browser.page.url();
    let re: RegExp;
    try {
      re = new RegExp(spec.pattern);
    } catch (err) {
      throw new Error(`browser.capture_url: invalid regex "${spec.pattern}" — ${(err as Error).message}`);
    }
    const match = re.exec(currentUrl);
    if (!match) {
      throw new Error(`browser.capture_url: pattern "${spec.pattern}" did not match URL "${currentUrl}"`);
    }
    // Prefer the first named group if present, else capture group 1, else full match.
    const value = match.groups ? Object.values(match.groups)[0] : (match[1] ?? match[0]);
    const key = spec.as.replace(/^context\./, "");
    ctx.context[key] = value;
    return;
  }

  if ("http.post" in raw || "http.get" in raw) {
    const method = "http.post" in raw ? "POST" : "GET";
    const spec = (raw["http.post"] ?? raw["http.get"]) as { url: string; auth?: string; body?: unknown };
    const url = resolve(spec.url, ctx);

    // Carry the browser session's cookies (populated by the app after sign-in)
    // so direct API calls share the same auth as the Playwright session.
    const cookies = spec.auth === "session"
      ? await browser.context.cookies()
      : undefined;

    const res = await httpRequest(method, url, {
      body: spec.body,
      cookies: cookies?.map(c => ({ name: c.name, value: c.value })),
    });

    // Stash the response for `http_status` asserts later in the same case.
    ctx.context[LAST_HTTP_STATUS] = res.status;
    return;
  }

  throw new Error(`Unknown action: ${JSON.stringify(action)}`);
}

async function runAssert(
  assert: IRAssert,
  browser: BrowserSession,
  ctx: RunContext,
  config: QaConfig,
  screenshotsDir: string,
): Promise<AssertResult> {
  const a = assert as unknown as Record<string, unknown>;

  if (a.type === "db" || a.type === "db_eventually") {
    if (!ctx.db) return { type: a.type as string, pass: false, detail: "No DB adapter configured" };

    const sql = resolve(a.sql as string, ctx);
    const params = resolveParams(a.params as string[], ctx);
    const expected = a.expect;
    const storeAs = a.storeAs as string | undefined;

    let rows: Record<string, unknown>[];
    if (a.type === "db_eventually") {
      const timeoutMs = (a.timeoutMs as number) ?? 10_000;
      rows = await pollUntil(
        () => ctx.db!.query<Record<string, unknown>>(sql, params),
        r => checkExpect(r, expected),
        timeoutMs,
      );
    } else {
      rows = await ctx.db.query<Record<string, unknown>>(sql, params);
    }

    const pass = checkExpect(rows, expected);

    if (pass && storeAs && rows[0]) {
      const firstVal = Object.values(rows[0])[0];
      ctx.context[storeAs.replace("context.", "")] = firstVal;
    }

    return {
      type: a.type as string,
      pass,
      detail: pass ? undefined : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(rows).slice(0, 300)}`,
    };
  }

  // ── Schema-aware DB asserts (no SQL in plans) ──────────────────────────
  if (
    a.type === "user_has_row_in" ||
    a.type === "user_row_count_in" ||
    a.type === "user_field_equals" ||
    a.type === "user_related_field" ||
    a.type === "user_related_count"
  ) {
    if (!ctx.db) return { type: a.type as string, pass: false, detail: "No DB adapter configured" };

    const graphGetter = (ctx as unknown as { getGraph?: () => FkGraph | undefined }).getGraph;
    const graph = graphGetter?.();
    if (!graph) {
      return { type: a.type as string, pass: false, detail: "schema.json missing — run 'qa learn' first" };
    }
    const { userTable, userEmailColumn } = config.db;
    const email = ctx.meta.testUser.email;

    // Resolve the target table for the assert.
    let targetTable: string;
    let field: string | undefined;
    let expected: unknown;
    let expectedCount: number | undefined;
    if (a.type === "user_has_row_in") {
      targetTable = (a.table ?? a.value) as string;
    } else if (a.type === "user_row_count_in") {
      targetTable = a.table as string;
      expectedCount = a.count as number;
    } else if (a.type === "user_field_equals") {
      targetTable = userTable;
      field = a.field as string;
      expected = a.value;
    } else if (a.type === "user_related_field") {
      targetTable = a.table as string;
      field = a.field as string;
      expected = a.value;
    } else {
      // user_related_count
      targetTable = a.table as string;
      expectedCount = a.count as number;
    }

    const where = buildUserScope(graph, userTable, userEmailColumn, targetTable);
    if (!where) {
      return {
        type: a.type as string, pass: false,
        detail: `No FK path found from ${targetTable} to ${userTable}. Add an explicit 'db' assert with raw SQL.`,
      };
    }

    try {
      if (a.type === "user_field_equals" || a.type === "user_related_field") {
        const rows = await ctx.db.query<Record<string, unknown>>(
          `SELECT ${field} AS v FROM ${targetTable} WHERE ${where} LIMIT 1`,
          [email],
        );
        const first = rows[0];
        if (!first) {
          return { type: a.type, pass: false, detail: `No row found in ${targetTable} for the test user` };
        }
        const actual = first.v;
        const pass = String(actual) === String(expected);
        return {
          type: a.type, pass,
          detail: pass ? undefined : `${targetTable}.${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        };
      }

      // Count-based asserts
      const rows = await ctx.db.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${targetTable} WHERE ${where}`,
        [email],
      );
      const actualCount = Number(rows[0]?.count ?? 0);

      if (a.type === "user_has_row_in") {
        const pass = actualCount > 0;
        return {
          type: "user_has_row_in", pass,
          detail: pass ? undefined : `No rows in ${targetTable} for the test user`,
        };
      }

      const pass = actualCount === expectedCount;
      return {
        type: a.type, pass,
        detail: pass ? undefined : `${targetTable}: expected count ${expectedCount}, got ${actualCount}`,
      };
    } catch (err) {
      return { type: a.type, pass: false, detail: `SQL error: ${(err as Error).message}` };
    }
  }

  if (a.type === "http_status") {
    const status = ctx.context[LAST_HTTP_STATUS];
    if (status === undefined) {
      return {
        type: "http_status", pass: false,
        detail: "No HTTP action ran in this case — can't check status",
      };
    }
    const pass = status === a.expect;
    // Consume so the next assert in this case can't accidentally reuse it.
    delete ctx.context[LAST_HTTP_STATUS];
    return {
      type: "http_status", pass,
      detail: pass ? undefined : `Expected status ${a.expect}, got ${status}`,
    };
  }

  if (a.type === "expect_text") {
    const pass = await expectText(browser.page, resolve(a.text as string, ctx), a.selector as string | undefined);
    return { type: "expect_text", pass, detail: pass ? undefined : `Text "${a.text}" not found` };
  }

  if (a.type === "expect_url") {
    const pass = await expectUrl(browser.page, resolve(a.pattern as string, ctx));
    return { type: "expect_url", pass, detail: pass ? undefined : `URL does not match "${a.pattern}". Current: ${browser.page.url()}` };
  }

  if (a.type === "ai_check") {
    const result = await runAiCheck(
      browser.page,
      resolve(a.assertion as string, ctx),
      Boolean(a.includeScreenshot),
      config,
      screenshotsDir,
    );
    return { type: "ai_check", pass: result.pass, detail: result.reason };
  }

  if (a.type === "expect_visible") {
    const target = resolve((a.target ?? a.text ?? a.selector) as string, ctx);
    const isSel = Boolean(a.selector) && !a.text;
    const pass = await expectVisible(browser.page, target, isSel);
    return { type: "expect_visible", pass, detail: pass ? undefined : `Not visible: "${target}"` };
  }

  if (a.type === "expect_not_visible") {
    const target = resolve((a.target ?? a.text ?? a.selector) as string, ctx);
    const isSel = Boolean(a.selector) && !a.text;
    const pass = await expectNotVisible(browser.page, target, isSel);
    return { type: "expect_not_visible", pass, detail: pass ? undefined : `Still visible: "${target}"` };
  }

  if (a.type === "expect_disabled") {
    const selector = resolve(a.selector as string, ctx);
    const pass = await expectDisabled(browser.page, selector);
    return { type: "expect_disabled", pass, detail: pass ? undefined : `Not disabled: "${selector}"` };
  }

  if (a.type === "expect_attribute") {
    const { selector, attr, value, pattern } = a as unknown as {
      selector: string; attr: string; value?: string; pattern?: string;
    };
    const match = pattern !== undefined ? "pattern" : "equals";
    const expected = resolve((pattern ?? value ?? "") as string, ctx);
    const { pass, actual } = await expectAttribute(
      browser.page, resolve(selector, ctx), attr, expected, match,
    );
    return {
      type: "expect_attribute", pass,
      detail: pass ? undefined : `Attribute ${attr}: expected "${expected}", got "${actual ?? "<null>"}"`,
    };
  }

  if (a.type === "expect_download") {
    // expect_download is handled in runCase via the download watcher arm/finish
    // cycle. If we reach here it means the watcher wasn't set up or already
    // fired — treat as a configuration error.
    return {
      type: "expect_download", pass: false,
      detail: "expect_download must be the first assert in a case; no download was captured.",
    };
  }

  if (a.type === "expect_modal") {
    const kind = a.kind as string;
    const selectors = [
      `[data-testid*="${kind}"]`,
      `[class*="${kind}"]`,
      `[aria-label*="${kind}" i]`,
      `text=/${kind}/i`,
    ];
    let pass = false;
    for (const sel of selectors) {
      const el = browser.page.locator(sel).first();
      if (await el.count() > 0) { pass = true; break; }
    }
    return { type: "expect_modal", pass, detail: pass ? undefined : `Modal of kind "${kind}" not found` };
  }

  return { type: a.type as string, pass: false, detail: `Unknown assert type: ${a.type}` };
}

function checkExpect(rows: Record<string, unknown>[], expected: unknown): boolean {
  if (expected === "non_empty") return rows.length > 0;
  if (expected === "empty") return rows.length === 0;
  const firstRow = rows[0];
  if (!firstRow) return false;
  const val = Object.values(firstRow)[0];
  if (typeof expected === "number") return Number(val) === expected;
  if (typeof expected === "string") return String(val) === expected;
  return false;
}

async function runTeardown(ir: IR, ctx: RunContext, config: QaConfig, qaToolDir: string): Promise<void> {
  console.log("\nRunning teardown...");

  // Auto cleanup via FK walk.
  if (ir.teardown?.cleanupUserData && ctx.db) {
    await cleanupUserData(ctx.db, config, qaToolDir, ctx.meta.testUser.email, "post-run");
  }

  if (ir.teardown?.sql && ctx.db) {
    for (const entry of ir.teardown.sql) {
      try {
        const params = resolveParams(entry.params, ctx);
        await ctx.db.query(entry.sql, params);
      } catch (err) {
        console.warn(`  Teardown SQL warning: ${(err as Error).message}`);
      }
    }
  }

  if (ir.teardown?.auth?.cleanupUser && ctx.auth) {
    try {
      let userId = ctx.context["test_user_id"] as string | undefined;

      // If the test created the user itself (signup flow), we don't have the id.
      // Look it up by email — which is why teardown.auth.cleanupUser is an email, not an id.
      if (!userId && ctx.auth.findUserByEmail) {
        const email = resolve(ir.teardown.auth.cleanupUser, ctx);
        const found = await ctx.auth.findUserByEmail(email);
        userId = found?.userId;
      }

      if (userId) {
        await ctx.auth.cleanup(userId);
        console.log(`  Cleaned up auth user ${userId}`);
      } else {
        console.log(`  No auth user to clean up (not found)`);
      }
    } catch (err) {
      console.warn(`  Auth cleanup warning: ${(err as Error).message}`);
    }
  }

  if (ctx.db) {
    await ctx.db.close();
  }
}

/**
 * FK-graph cleanup. Walks from config.db.userTable leaf-first and deletes all
 * rows that belong to the test user (identified by userEmailColumn = email).
 * Honors config.db.cleanupExcludeTables. Each DELETE is wrapped in try/catch
 * so a single-table failure doesn't abort the rest.
 */
async function cleanupUserData(
  db: DbAdapter,
  config: QaConfig,
  qaToolDir: string,
  email: string,
  phase: "pre-run" | "post-run",
): Promise<void> {
  const { userTable, userEmailColumn, cleanupExcludeTables } = config.db;

  const schemaPath = join(qaToolDir, "schema.json");
  if (!existsSync(schemaPath)) {
    console.warn(`  [${phase}] Skipping cleanupUserData — ${schemaPath} missing. Run 'qa learn' first.`);
    return;
  }

  const schema: SchemaAnalysis = JSON.parse(readFileSync(schemaPath, "utf8"));
  const graph = buildFkGraph(schema);
  const exclude = new Set(cleanupExcludeTables ?? []);

  const tables = computeDeleteOrder(graph, userTable, exclude);
  console.log(`  [${phase}] Cleanup: walking ${tables.length} tables from ${userTable}`);

  // For each non-root table, we need a WHERE clause that scopes rows to the
  // user. Use the shortest FK path.
  const { buildUserScope } = await import("../fk-graph.js");

  for (const table of tables) {
    const where = buildUserScope(graph, userTable, userEmailColumn, table);
    if (!where) {
      // Usually only the root hits this (target === userTable). Handle below.
      if (table === userTable) {
        try {
          const res = await db.query<{ count: number }>(
            `DELETE FROM ${userTable} WHERE ${userEmailColumn} = $1`,
            [email],
          );
          void res;
          console.log(`    deleted ${userTable}`);
        } catch (err) {
          console.warn(`    [${phase}] ${userTable}: ${(err as Error).message}`);
        }
      }
      continue;
    }
    try {
      await db.query(`DELETE FROM ${table} WHERE ${where}`, [email]);
      console.log(`    deleted ${table}`);
    } catch (err) {
      console.warn(`    [${phase}] ${table}: ${(err as Error).message}`);
    }
  }
}

/** Fill Clerk / generic login forms. Used both by setup.signIn: "ui" and by
 *  the browser.fill_form plan action. */
async function fillLoginForm(browser: BrowserSession, email: string, password: string): Promise<void> {
  const emailSelectors = [
    'input[name="emailAddress"]',   // Clerk SignUp
    'input[name="identifier"]',     // Clerk SignIn
    'input[type="email"]',
    'input[name="email"]',
    '#email',
  ];
  const passwordSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    const el = browser.page.locator(sel).first();
    if (await el.count() > 0) {
      await el.fill(email);
      emailFilled = true;
      break;
    }
  }
  if (!emailFilled) {
    throw new Error(
      `No email input found on ${browser.page.url()}. Tried: ${emailSelectors.join(", ")}. ` +
      `Use explicit browser.fill with your app's actual selector, or drive Clerk's multi-step flow manually.`,
    );
  }

  for (const sel of passwordSelectors) {
    const el = browser.page.locator(sel).first();
    if (await el.count() > 0) { await el.fill(password); break; }
  }
}

function generateRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}
