import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import type { QaConfig, AiConfig } from "./types.js";

let _config: QaConfig | null = null;
let _root: string | null = null;

const CONFIG_PATHS = [
  ".aivion-qa/qa.config.yaml",   // preferred
  ".qa-tool/qa.config.yaml",     // legacy (pre-rename)
  "qa.config.yaml",              // oldest legacy (repo root)
] as const;

/** Locate qa.config.yaml — walks up from `from` until it finds one. */
export function findProjectRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  while (true) {
    if (CONFIG_PATHS.some((p) => existsSync(join(dir, p)))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error("qa.config.yaml not found. Run `aivion-qa init` first.");
    dir = parent;
  }
}

/** Return the absolute path to qa.config.yaml for a given project root. */
export function findConfigPath(root: string): string {
  for (const p of CONFIG_PATHS) {
    const abs = join(root, p);
    if (existsSync(abs)) return abs;
  }
  return join(root, CONFIG_PATHS[0]);
}

export function getProjectRoot(): string {
  if (!_root) _root = findProjectRoot();
  return _root;
}

export function loadConfig(rootDir?: string): QaConfig {
  if (_config && !rootDir) return _config;

  const root = rootDir ?? findProjectRoot();
  _root = root;

  const envPath = join(root, ".env");
  if (existsSync(envPath)) loadDotenv({ path: envPath });

  const raw = readFileSync(findConfigPath(root), "utf8");
  const yaml = parseYaml(raw) as Record<string, unknown>;

  _config = normalizeConfig(yaml);
  return _config;
}

function normalizeConfig(raw: Record<string, unknown>): QaConfig {
  const urls = (raw.baseUrls ?? raw.base_urls ?? {}) as Record<string, string>;
  if (!urls || typeof urls !== "object") {
    throw new Error("qa.config.yaml: baseUrls must be a map of name → URL");
  }

  // auth is optional — local/in-app auth setups omit it entirely.
  let auth: QaConfig["auth"] | undefined;
  if (raw.auth) {
    const authRaw = raw.auth as Record<string, string>;
    if (authRaw.provider !== "clerk") {
      throw new Error(
        `qa.config.yaml: auth.provider must be 'clerk' (only provider in v0.1). ` +
        `For local in-app auth, omit the auth block entirely — see docs/auth/local.md.`,
      );
    }
    auth = {
      provider: "clerk",
      secretKeyEnv: (authRaw.secretKeyEnv ?? authRaw.secret_key_env ?? "CLERK_SECRET_KEY") as string,
    };
  }

  const dbRaw = (raw.db ?? {}) as Record<string, unknown>;

  const aiRaw = (raw.ai ?? { mode: "off" }) as Record<string, unknown>;
  const ai = normalizeAiConfig(aiRaw);

  return {
    baseUrls: urls,
    auth,
    db: {
      connectionStringEnv: (dbRaw.connectionStringEnv ?? dbRaw.connection_string_env ?? "DATABASE_URL") as string,
      userTable: (dbRaw.userTable ?? dbRaw.user_table ?? "users") as string,
      userEmailColumn: (dbRaw.userEmailColumn ?? dbRaw.user_email_column ?? "email") as string,
      cleanupExcludeTables: (dbRaw.cleanupExcludeTables ?? dbRaw.cleanup_exclude_tables ?? undefined) as string[] | undefined,
    },
    ai,
  };
}

function normalizeAiConfig(raw: Record<string, unknown>): AiConfig {
  const mode = (raw.mode ?? "off") as string;
  if (mode !== "off" && mode !== "claude_cli" && mode !== "sdk") {
    throw new Error(`qa.config.yaml: ai.mode must be 'off', 'claude_cli', or 'sdk', got '${mode}'`);
  }

  const cfg: AiConfig = { mode: mode as "off" | "claude_cli" | "sdk" };

  if (typeof raw.model === "string") {
    cfg.model = raw.model;
  }

  if (raw.sdk) {
    const sdk = raw.sdk as Record<string, string>;
    cfg.sdk = {
      provider: sdk.provider ?? "anthropic",
      model: sdk.model ?? "claude-sonnet-4-6",
      apiKeyEnv: sdk.apiKeyEnv ?? sdk.api_key_env,
      baseUrl: sdk.baseUrl ?? sdk.base_url,
    };
  }

  if (raw.tasks) {
    cfg.tasks = raw.tasks as AiConfig["tasks"];
  }

  return cfg;
}

export function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

export function getEnvOptional(name: string): string | undefined {
  return process.env[name];
}
