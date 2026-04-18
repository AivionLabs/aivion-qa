import type { BrowserContext, Page } from "playwright";
import type { AuthAdapter, UserSpec, UserCredentials } from "../../types.js";

const CLERK_API = "https://api.clerk.com/v1";

// Route matcher for Clerk Frontend API — development (*.clerk.accounts.dev)
// and production (clerk.<app-domain>). Users whose production Clerk host doesn't
// match can override via ClerkAdapter `frontendHostPattern`.
const DEFAULT_CLERK_HOST_RE = /(?:^|\.)(clerk\.accounts\.dev|clerk\.)/;

export class ClerkAdapter implements AuthAdapter {
  private readonly secretKey: string;
  private readonly frontendHostPattern: RegExp;

  constructor(secretKey: string, frontendHostPattern: RegExp = DEFAULT_CLERK_HOST_RE) {
    this.secretKey = secretKey;
    this.frontendHostPattern = frontendHostPattern;
  }

  async createUser(spec: UserSpec): Promise<UserCredentials> {
    const body: Record<string, unknown> = {
      email_address: [spec.email],
    };

    // Always skip password strength + breach checks — these are test users,
    // not production accounts. `TestPassword123!` and similar common strings
    // are on HIBP and would otherwise be rejected on instances with the
    // "password leak protection" setting enabled.
    body.skip_password_checks = true;

    if (spec.password) {
      body.password = spec.password;
    } else {
      body.skip_password_requirement = true;
    }

    if (spec.firstName) body.first_name = spec.firstName;
    if (spec.lastName) body.last_name = spec.lastName;

    const res = await this.clerkFetch("POST", "/users", body);

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ message: string }> };
      const msg = err.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Clerk createUser failed: ${msg}`);
    }

    const user = (await res.json()) as { id: string; email_addresses: Array<{ email_address: string }> };
    return {
      userId: user.id,
      email: user.email_addresses[0]?.email_address ?? spec.email,
      password: spec.password,
    };
  }

  /**
   * Mint a Clerk testing token. Testing tokens bypass Clerk's bot detection
   * so scripted sign-in / sign-up flows don't trip the challenge. They do NOT
   * themselves authenticate a user — the test still drives the Clerk UI, or
   * uses a session token minted separately.
   *
   * Requires `CLERK_TESTING_ENABLED=true` on the Clerk instance (dev/preview only).
   */
  async getTestingToken(): Promise<string> {
    const res = await this.clerkFetch("POST", "/testing_tokens", {});
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ message: string }> };
      const msg = err.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(
        `Clerk getTestingToken failed: ${msg}. Ensure CLERK_TESTING_ENABLED=true on your Clerk instance.`,
      );
    }
    const data = (await res.json()) as { token: string };
    return data.token;
  }

  async findUserByEmail(email: string): Promise<UserCredentials | null> {
    const qs = `email_address=${encodeURIComponent(email)}`;
    const res = await this.clerkFetch("GET", `/users?${qs}`);
    if (!res.ok) return null;
    const users = (await res.json()) as Array<{ id: string; email_addresses: Array<{ email_address: string }> }>;
    const first = users[0];
    if (!first) return null;
    return {
      userId: first.id,
      email: first.email_addresses[0]?.email_address ?? email,
    };
  }

  async cleanup(userId: string): Promise<void> {
    const res = await this.clerkFetch("DELETE", `/users/${userId}`);
    if (!res.ok && res.status !== 404) {
      const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ message: string }> };
      const msg = err.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Clerk cleanup failed for user ${userId}: ${msg}`);
    }
  }

  /**
   * Installs testing-token interception on Clerk Frontend API requests so
   * scripted flows don't trip bot detection.
   */
  async applyToContext(context: BrowserContext): Promise<void> {
    const testingToken = await this.getTestingToken();
    await context.route(this.frontendHostPattern, async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("__clerk_testing_token")) {
        url.searchParams.set("__clerk_testing_token", testingToken);
      }
      await route.continue({ url: url.toString() });
    });
  }

  /**
   * Programmatic sign-in via a one-time sign-in token. The Backend API
   * returns both the token AND the full Accounts Portal URL that consumes
   * it (e.g. `https://<slug>.accounts.dev/sign-in?__clerk_ticket=...&__clerk_status=sign_in`).
   * Navigating there signs the user in and redirects back to the app.
   */
  async signInViaToken(page: Page, userId: string): Promise<void> {
    const { url } = await this.mintSignInToken(userId);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Wait for Clerk to process the ticket and redirect us off any /sign-in URL.
    await page.waitForURL(
      (u) => {
        const s = u.toString();
        return !s.includes("/sign-in") && !s.includes("/login") && !s.includes("accounts.dev");
      },
      { timeout: 20_000 },
    );
  }

  /** Sign-in token — returns { token, url }. The URL is the fully-formed
   *  Accounts Portal entry point; navigating there activates the ticket. */
  private async mintSignInToken(userId: string): Promise<{ token: string; url: string }> {
    const res = await this.clerkFetch("POST", "/sign_in_tokens", { user_id: userId });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ message: string }> };
      const msg = err.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Clerk mintSignInToken failed: ${msg}`);
    }
    const data = (await res.json()) as { token: string; url: string };
    return { token: data.token, url: data.url };
  }

  private clerkFetch(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${CLERK_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

export function createClerkAdapter(secretKeyEnv: string): ClerkAdapter {
  const key = process.env[secretKeyEnv];
  if (!key) throw new Error(`Env var ${secretKeyEnv} is not set (required for Clerk auth adapter)`);
  return new ClerkAdapter(key);
}
