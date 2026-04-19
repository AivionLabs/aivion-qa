import type { RunContext } from "../types.js";

/**
 * Resolve `{{meta.test_user.email}}`, `{{context.user_id}}`, `{{meta.environments.app}}`, etc.
 *
 * We accept snake_case in templates (the documented public convention) even
 * though the IR objects use camelCase internally. Each segment is tried literal
 * first, then camelCased.
 */
export function resolve(template: string, ctx: RunContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const trimmed = path.trim();
    const val = getPath(trimmed, ctx);
    if (val === undefined || val === null) {
      const avail = describeAvailable(trimmed, ctx);
      throw new Error(`Template reference {{${trimmed}}} is not resolved.${avail}`);
    }
    return String(val);
  });
}

export function resolveParams(params: unknown[], ctx: RunContext): unknown[] {
  return params.map(p => {
    if (typeof p === "string" && p.includes("{{")) return resolve(p, ctx);
    return p;
  });
}

/** Walk a value and template-resolve every string. Use for http bodies,
 *  header maps, and other arbitrarily-shaped objects users may template. */
export function resolveDeep<T = unknown>(value: T, ctx: RunContext): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return (value.includes("{{") ? resolve(value, ctx) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveDeep(v, ctx)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out as T;
  }
  return value;
}

function getPath(path: string, ctx: RunContext): unknown {
  const parts = path.split(".");
  const head = parts[0];

  if (head === "meta") {
    return walk(ctx.meta as unknown as Record<string, unknown>, parts.slice(1));
  }
  if (head === "context") {
    // context keys are user-controlled (via storeAs) — literal only.
    return walkLiteral(ctx.context as Record<string, unknown>, parts.slice(1));
  }
  // Fallback: treat as a meta-rooted path.
  return walk(ctx.meta as unknown as Record<string, unknown>, parts);
}

/** Walks an object, accepting either literal or camelCased segment keys. */
function walk(obj: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    const bag = cur as Record<string, unknown>;
    const camel = toCamelCase(part);
    cur = part in bag ? bag[part] : bag[camel];
  }
  return cur;
}

function walkLiteral(obj: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function describeAvailable(path: string, ctx: RunContext): string {
  const head = path.split(".")[0];
  if (head === "context") {
    const keys = Object.keys(ctx.context);
    return keys.length ? ` Available context keys: ${keys.join(", ")}` : " Context bag is empty (no prior case has run `storeAs` yet).";
  }
  if (head === "meta") {
    const keys = Object.keys(ctx.meta);
    return ` Available meta keys: ${keys.join(", ")}`;
  }
  return "";
}
