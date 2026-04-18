import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AiConfig, AiTask } from "../types.js";

const execFileAsync = promisify(execFile);

export interface AiCallOptions<T = unknown> {
  config: AiConfig;
  task: AiTask;
  systemPrompt: string;
  userPrompt: string;
  schema?: z.ZodType<T>;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface AiCallResult<T = unknown> {
  data: T;
  rawText: string;
}

export async function callAi<T>(opts: AiCallOptions<T>): Promise<AiCallResult<T>> {
  if (opts.config.mode === "off") {
    throw new Error(
      "AI is disabled (ai.mode = off). This assertion or feature requires an LLM. " +
      "Enable by setting ai.mode: claude_cli (or sdk) in qa.config.yaml.",
    );
  }
  if (opts.config.mode === "claude_cli") return callClaudeCli(opts);
  if (opts.config.mode === "sdk") return callSdk(opts);
  throw new Error(`Unknown ai.mode: ${opts.config.mode as string}`);
}

async function callClaudeCli<T>(opts: AiCallOptions<T>): Promise<AiCallResult<T>> {
  if (opts.imageBase64) {
    console.warn("[ai] claude_cli mode does not support images yet — sending DOM text only");
  }

  // Per-task override wins over top-level default.
  const model = opts.config.tasks?.[opts.task]?.model ?? opts.config.model;

  const text = await runClaude(opts.systemPrompt, opts.userPrompt, model);

  if (!opts.schema) {
    return { data: text as unknown as T, rawText: text };
  }

  return parseWithSchemaAndRetry(text, opts, (retryPrompt) =>
    runClaude(opts.systemPrompt, retryPrompt, model),
  );
}

async function runClaude(systemPrompt: string, userPrompt: string, model?: string): Promise<string> {
  const prompt = `${systemPrompt}\n\n${userPrompt}`;

  const args = ["-p", prompt, "--output-format", "json"];
  if (model) args.push("--model", model);

  let stdout: string;
  try {
    const result = await execFileAsync("claude", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    throw new Error(`claude CLI failed: ${e.message ?? "unknown error"}\n${e.stderr ?? ""}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output:\n${stdout.slice(0, 500)}`);
  }

  const inner = (parsed as Record<string, unknown>).result ?? stdout;
  return typeof inner === "string" ? inner : JSON.stringify(inner);
}

/**
 * Parse `text` against the schema. On ZodError, retry ONCE by feeding the
 * specific validation errors back to the LLM. Most shape mismatches self-heal
 * on the second try — cheaper than making the schema permissive enough to
 * swallow anything.
 */
async function parseWithSchemaAndRetry<T>(
  text: string,
  opts: AiCallOptions<T>,
  retry: (retryPrompt: string) => Promise<string>,
): Promise<AiCallResult<T>> {
  const schema = opts.schema!;

  try {
    const obj = extractJson(text);
    return { data: schema.parse(obj) as T, rawText: text };
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;

    const issues = err.issues
      .map((i) => `- at ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");

    console.warn(`[ai] compile output failed schema validation — retrying once with feedback:\n${issues}`);

    const retryPrompt = `${opts.userPrompt}

Your previous response failed schema validation with these errors:
${issues}

Return ONLY corrected JSON that fixes these specific issues. Do not include prose or markdown fences.`;

    const text2 = await retry(retryPrompt);
    const obj2 = extractJson(text2);
    return { data: schema.parse(obj2) as T, rawText: text2 };
  }
}

async function callSdk<T>(opts: AiCallOptions<T>): Promise<AiCallResult<T>> {
  const { config, schema, imageBase64, imageMimeType, task } = opts;

  const taskOverride = config.tasks?.[task];
  const sdkCfg = config.sdk ?? { provider: "anthropic", model: "claude-sonnet-4-6" };
  const provider = taskOverride?.provider ?? sdkCfg.provider;
  const model = taskOverride?.model ?? sdkCfg.model;

  const { generateObject, generateText } = await import("ai");

  const modelInstance = await resolveModel(provider, model, sdkCfg);

  const messages = buildMessages(opts.userPrompt, imageBase64, imageMimeType);

  if (schema) {
    const { object } = await generateObject({
      model: modelInstance,
      schema,
      system: opts.systemPrompt,
      messages,
    });
    return { data: object as T, rawText: JSON.stringify(object) };
  }

  const { text } = await generateText({
    model: modelInstance,
    system: opts.systemPrompt,
    messages,
  });
  return { data: text as unknown as T, rawText: text };
}

function buildMessages(
  userPrompt: string,
  imageBase64?: string,
  imageMimeType?: string,
): import("ai").CoreMessage[] {
  if (imageBase64 && imageMimeType) {
    return [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image",
            image: imageBase64,
            mimeType: imageMimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          },
        ],
      },
    ];
  }
  return [{ role: "user", content: userPrompt }];
}

async function resolveModel(
  provider: string,
  model: string,
  sdkCfg: NonNullable<AiConfig["sdk"]>,
): Promise<import("ai").LanguageModel> {
  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const apiKey = sdkCfg.apiKeyEnv ? process.env[sdkCfg.apiKeyEnv] : process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (required for sdk mode with anthropic provider)");
      return createAnthropic({ apiKey })(model);
    }
    default:
      throw new Error(
        `Provider '${provider}' is not bundled. Install its @ai-sdk/<provider> package and add a case in src/ai/caller.ts`,
      );
  }
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fence-stripping fallback for LLMs that wrap JSON in markdown.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]!);
      } catch {
        /* fall through */
      }
    }
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Could not extract JSON from LLM response:\n${text.slice(0, 500)}`);
  }
}
