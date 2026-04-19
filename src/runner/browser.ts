import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(headless = true): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page };
}

export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
}

export async function click(page: Page, target: string): Promise<void> {
  const locator = looksLikeCssSelector(target)
    ? page.locator(target)
    // Text fallback. Exact match prevents accidental hits (e.g. "Sign in with
    // Google Continue" matching a plain "Continue"). Role-first for a11y,
    // then any exact-text element.
    : page
        .getByRole("button", { name: target, exact: true })
        .or(page.getByText(target, { exact: true }))
        .first();
  await locator.click({ timeout: 10_000 });
}

function looksLikeCssSelector(s: string): boolean {
  const t = s.trim();
  // CSS selectors typically start with #, ., [, * or a tag+brace/dot/hash.
  return /^[#.\[*]/.test(t) || /^[a-z][a-z0-9-]*[\[.#:]/i.test(t);
}

export async function fill(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).fill(value, { timeout: 10_000 });
}

export async function submit(page: Page): Promise<void> {
  // Try common submit patterns
  const submitBtn = page.locator("button[type=submit], input[type=submit]").first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click({ timeout: 10_000 });
  } else {
    await page.keyboard.press("Enter");
  }
}

export async function waitFor(page: Page, selector: string): Promise<void> {
  await page.locator(selector).waitFor({ state: "visible", timeout: 15_000 });
}

/** Press one or more keys. Accepts Playwright key syntax: "Enter", "Escape",
 *  "Control+Shift+P", "Meta+K", etc. */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

/** Drag from one selector to another. Both must be visible + actionable. */
export async function dragTo(page: Page, fromSelector: string, toSelector: string): Promise<void> {
  await page.locator(fromSelector).dragTo(page.locator(toSelector), { timeout: 15_000 });
}

export async function expectText(page: Page, text: string, selector?: string): Promise<boolean> {
  try {
    if (selector) {
      await page.locator(selector).filter({ hasText: text }).waitFor({ state: "visible", timeout: 5_000 });
    } else {
      await page.locator(`text=${text}`).first().waitFor({ state: "visible", timeout: 5_000 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Visible = at least one match, and it's rendered. Accepts text or selector. */
export async function expectVisible(page: Page, target: string, isSelector: boolean): Promise<boolean> {
  try {
    const locator = isSelector ? page.locator(target) : page.getByText(target).first();
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Not visible = no match, or all matches are hidden. Waits briefly to let
 *  the UI settle. */
export async function expectNotVisible(page: Page, target: string, isSelector: boolean): Promise<boolean> {
  try {
    const locator = isSelector ? page.locator(target) : page.getByText(target).first();
    const count = await locator.count();
    if (count === 0) return true;
    // Wait up to 2s for it to disappear.
    await locator.first().waitFor({ state: "hidden", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export async function expectDisabled(page: Page, selector: string): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 5_000 });
    return await el.isDisabled();
  } catch {
    return false;
  }
}

export async function expectAttribute(
  page: Page,
  selector: string,
  attr: string,
  expected: string,
  match: "equals" | "pattern",
): Promise<{ pass: boolean; actual: string | null }> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
  const actual = await el.getAttribute(attr).catch(() => null);
  if (actual === null) return { pass: false, actual };
  if (match === "equals") return { pass: actual === expected, actual };
  try {
    const re = new RegExp(expected);
    return { pass: re.test(actual), actual };
  } catch {
    return { pass: actual.includes(expected), actual };
  }
}

/** Waits for a Playwright "download" event triggered by the next action in
 *  the case. Must be called BEFORE triggering the download. Returns a handle
 *  with a one-shot `finish()` that resolves once the download completes. */
export function armDownloadWatcher(
  page: Page,
  filenamePattern?: string,
): { finish: (timeoutMs?: number) => Promise<{ pass: boolean; actual?: string }> } {
  let resolved = false;
  let actualFilename: string | undefined;

  const promise = page
    .waitForEvent("download", { timeout: 10_000 })
    .then(async (dl) => {
      actualFilename = dl.suggestedFilename();
      resolved = true;
    })
    .catch(() => undefined);

  return {
    finish: async (timeoutMs = 10_000) => {
      await Promise.race([promise, new Promise((r) => setTimeout(r, timeoutMs))]);
      if (!resolved) return { pass: false };
      if (!filenamePattern) return { pass: true, actual: actualFilename };
      try {
        const re = new RegExp(
          filenamePattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*"),
        );
        return { pass: re.test(actualFilename!), actual: actualFilename };
      } catch {
        return { pass: actualFilename!.includes(filenamePattern), actual: actualFilename };
      }
    },
  };
}

export async function expectUrl(page: Page, pattern: string): Promise<boolean> {
  const currentUrl = page.url();
  if (pattern.startsWith("/")) {
    return currentUrl.includes(pattern);
  }
  try {
    const re = new RegExp(pattern);
    return re.test(currentUrl);
  } catch {
    return currentUrl.includes(pattern);
  }
}

export async function captureScreenshot(page: Page, outputPath: string): Promise<void> {
  await page.screenshot({ path: outputPath, fullPage: false });
}

export async function getDomSnapshot(page: Page): Promise<string> {
  return page.content();
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await session.browser.close();
}

// Network interception — must be set up before navigation
export interface NetworkWatcher {
  stop: () => string[];
}

export function watchNetwork(page: Page, pattern: string): NetworkWatcher {
  const matched: string[] = [];
  const handler = (req: import("playwright").Request) => {
    if (req.url().includes(pattern)) matched.push(req.url());
  };
  page.on("request", handler);
  return {
    stop: () => {
      page.off("request", handler);
      return matched;
    },
  };
}
