// ── Shared types ────────────────────────────────────────────────────────────

export interface QaConfig {
  baseUrls: Record<string, string>;   // { app: "http://localhost:3000", api: "..." }
  auth?: {
    provider: "clerk";
    secretKeyEnv: string;             // env var name holding the secret key
  };
  db: {
    connectionStringEnv: string;      // env var name holding DATABASE_URL
    userTable: string;                // root table for FK walks (default: "users")
    userEmailColumn: string;          // email lookup column (default: "email")
    cleanupExcludeTables?: string[];  // tables to skip during FK-walk cleanup (e.g. ["audit_logs"])
  };
  ai: AiConfig;
}

export type AiMode = "off" | "claude_cli" | "sdk";

export interface AiConfig {
  mode: AiMode;
  /** Default model for claude_cli mode. Accepted: "opus" | "sonnet" | "haiku" | full model id like "claude-opus-4-7". */
  model?: string;
  sdk?: {
    provider: string;                 // "anthropic" | "openai" | "ollama" | ...
    model: string;
    apiKeyEnv?: string;
    baseUrl?: string;
  };
  tasks?: Partial<Record<AiTask, { provider?: string; model: string }>>;
}

export type AiTask = "compile" | "ai_check" | "summary" | "self_heal";

// ── IR types ────────────────────────────────────────────────────────────────

export interface IR {
  meta: IRMeta;
  setup: IRSetup;
  /** Either a flat list of cases OR URL-keyed groups. `groups` auto-navigates
   *  to each group's URL before its cases run. One or the other, not both. */
  cases?: IRCase[];
  groups?: Array<{ url: string; cases: IRCase[] }>;
  teardown: IRTeardown;
}

export interface IRMeta {
  plan: string;
  planHash: string;
  compiledAt: string;
  runId?: string;                     // injected at execute time
  testUser: {
    email: string;
    password?: string;
  };
  environments: Record<string, string>;
  /** Optional ISO timestamp injected as X-QA-Now header + __qa_now cookie.
   *  Backend must opt-in (gate by NODE_ENV=test) to honor it. */
  fakeNow?: string;
}

export interface IRSetup {
  auth?: {
    createUser: {
      email: string;
      via: string;
    };
  };
  seedSql?: string[];
  /** Walk the FK graph from config.db.userTable and DELETE the test user's
   * data (honoring db.cleanupExcludeTables). Runs before any case. */
  cleanupUserData?: boolean;
  /** How the browser gets signed in before any test case runs.
   *  - "ui" (default when createUser is set): drives /login form with test credentials
   *  - "ticket": programmatic sign-in via Clerk sign-in ticket (faster, no UI tested)
   *  - "none": no auto-login; the plan handles it */
  signIn?: "ui" | "ticket" | "none";
  /** Custom sign-in action sequence. Overrides `signIn: ui`'s built-in form-fill.
   *  Use when your login path or form shape doesn't match the defaults — e.g.
   *  Clerk's multi-step flow, or a non-/login path. */
  signInFlow?: IRAction[];
}

export interface IRCase {
  id: string;
  title: string;
  expectedFail?: { bug: string };
  actions?: IRAction[];
  asserts?: IRAssert[];
}

export type IRAction =
  | { "browser.goto": string }
  | { "browser.click": string }
  | { "browser.fill": { selector: string; value: string } }
  | { "browser.fill_form": { from: string } }
  | { "browser.submit": true }
  | { "browser.wait_for": string }
  | { "http.post": { url: string; auth?: string; body?: unknown } }
  | { "http.get": { url: string; auth?: string } };

export type IRAssert =
  | DbAssert
  | DbEventuallyAssert
  | HttpStatusAssert
  | ExpectTextAssert
  | ExpectUrlAssert
  | NoNetworkCallAssert
  | AiCheckAssert
  | ExpectModalAssert;

export interface DbAssert {
  type: "db";
  sql: string;
  params: string[];
  expect: string | number | "non_empty" | "empty";
  storeAs?: string;
}

export interface DbEventuallyAssert {
  type: "db_eventually";
  sql: string;
  params: string[];
  expect: string | number | "non_empty" | "empty";
  timeoutMs: number;
  storeAs?: string;
}

export interface HttpStatusAssert {
  type: "http_status";
  expect: number;
}

export interface ExpectTextAssert {
  type: "expect_text";
  selector?: string;
  text: string;
}

export interface ExpectUrlAssert {
  type: "expect_url";
  pattern: string;          // substring or regex string
}

export interface NoNetworkCallAssert {
  type: "no_network_call_matching";
  pattern: string;          // URL substring to watch for
  windowMs?: number;        // how long to observe (default 2000)
}

export interface AiCheckAssert {
  type: "ai_check";
  assertion: string;        // natural language
  includeScreenshot?: boolean;
}

export interface ExpectModalAssert {
  type: "expect_modal";
  kind: string;             // e.g. "upgrade"
}

export interface IRTeardown {
  sql?: Array<{ sql: string; params: string[] }>;
  auth?: { cleanupUser: string };
  /** Walk the FK graph and DELETE the test user's data after the last case. */
  cleanupUserData?: boolean;
}

// ── Auth adapter ─────────────────────────────────────────────────────────────

export interface UserSpec {
  email: string;
  password?: string;
  firstName?: string;
  lastName?: string;
}

export interface UserCredentials {
  userId: string;
  email: string;
  password?: string;
}

export interface AuthAdapter {
  createUser(spec: UserSpec): Promise<UserCredentials>;
  findUserByEmail?(email: string): Promise<UserCredentials | null>;
  cleanup(userId: string): Promise<void>;
  /**
   * Install context-level auth plumbing (e.g. Clerk testing token route for
   * bot-detection bypass). Called once right after browser launch.
   */
  applyToContext(context: import("playwright").BrowserContext): Promise<void>;
  /**
   * Programmatic sign-in. Navigates the page so the user ends up authenticated.
   * For Clerk: mints a sign-in token and navigates the page to the Accounts
   * Portal URL that activates it. Returns when the browser has landed on the
   * app (off any sign-in URL). Optional — adapters without a server-side
   * sign-in mechanism omit it.
   */
  signInViaToken?(page: import("playwright").Page, userId: string): Promise<void>;
}

// ── DB adapter ───────────────────────────────────────────────────────────────

export interface DbAdapter {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// ── Run context ──────────────────────────────────────────────────────────────

export type ContextBag = Record<string, unknown>;

export interface RunContext {
  runId: string;
  meta: IRMeta;
  context: ContextBag;
  auth?: AuthAdapter;
  db?: DbAdapter;
  /** Captured at run setup so the `auth.sign_in_again` action can replay it. */
  signInMode?: "ui" | "ticket" | "none";
  signInFlow?: IRAction[];
}

// ── Report types ─────────────────────────────────────────────────────────────

export type CaseStatus = "pass" | "fail" | "expected_fail" | "skip";

export interface CaseResult {
  id: string;
  title: string;
  status: CaseStatus;
  durationMs: number;
  error?: string;
  screenshots?: string[];
  expectedFail?: { bug: string };
  assertResults?: AssertResult[];
}

export interface AssertResult {
  type: string;
  pass: boolean;
  detail?: string;
}

export interface RunReport {
  planName: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  expectedFailed: number;
  skipped: number;
  cases: CaseResult[];
  aiSummary?: string;
}

// ── Schema analysis ──────────────────────────────────────────────────────────

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  primaryKey: string[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
  semanticSummary?: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

export interface SchemaForeignKey {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaAnalysis {
  analyzedAt: string;
  schemaHash: string;
  tables: SchemaTable[];
}
