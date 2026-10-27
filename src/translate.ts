import { parse } from "yaml";

/** Invocation policy shared by DSH discovery consumers. */
export interface SkillInvocation {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

/** Success result of parsing an OpenClaw skill into DSH shape (no locator/path). */
export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  whenToUse?: string;
  metadata?: Readonly<Record<string, unknown>>;
  readonly invocation: SkillInvocation;
  readonly content: string;
}

export type ParseResult = ParsedSkill | { readonly error: string };

/** Split a raw skill file into YAML frontmatter data and markdown body. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = parse(raw.slice(start, closing.start));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/** Normalize an arbitrary directory/file stem into a valid kebab-case skill name. */
export function toSkillName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function booleanField(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true": case "yes": case "on": return true;
      case "false": case "no": case "off": return false;
    }
  }
  throw new TypeError("frontmatter field '" + key + "' must be a boolean");
}

/** Map OpenClaw invocation frontmatter to the DSH invocation policy (fails closed). */
export function resolveInvocation(data: Record<string, unknown>): SkillInvocation {
  const disableModelInvocation = booleanField(data, "disable-model-invocation");
  const userInvocable = booleanField(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function metadataField(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = data.metadata;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Parse an OpenClaw SKILL.md file into a DSH-shaped definition.
 * The skill name falls back to the containing directory name (OpenClaw behavior).
 */
export function parseOpenClawSkill(raw: string, dirName: string): ParseResult {
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) return { error: "missing or invalid YAML frontmatter" };
  const name = toSkillName(stringField(parsed.data, "name") ?? dirName);
  const description = stringField(parsed.data, "description");
  if (name.length === 0) return { error: "skill name is empty" };
  if (description === undefined) return { error: "frontmatter requires a description" };
  let invocation: SkillInvocation;
  try {
    invocation = resolveInvocation(parsed.data);
  } catch (e) {
    return { error: String((e as Error).message) };
  }
  const whenToUse = stringField(parsed.data, "whenToUse");
  const metadata = metadataField(parsed.data);
  const result: ParsedSkill = { name, description, invocation, content: parsed.body.trim() };
  if (whenToUse !== undefined) result.whenToUse = whenToUse;
  if (metadata !== undefined) result.metadata = metadata;
  return result;
}

/** Replace OpenClaw's {baseDir} token with the skill directory absolute path. */
export function rewriteBaseDir(content: string, directory: string): string {
  return content.split("{baseDir}").join(directory);
}

export interface GatingResult {
  readonly pass: boolean;
  readonly reason?: string;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) if (typeof v === "string") out.push(v);
  return out;
}

function booleanish(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function osMatches(platform: string, os: string): boolean {
  const p = platform === "darwin" || platform === "macos" ? "darwin" : platform;
  const o = os === "macos" ? "darwin" : os;
  return p === o;
}

/**
 * Evaluate OpenClaw gating (metadata.openclaw.requires) against the DSH host.
 * Supports bins / anyBins / env / os / always. requires.config references
 * openclaw.json and is not enforceable on DSH, so it is ignored.
 */
export function evaluateOpenClawGating(
  metadata: Readonly<Record<string, unknown>> | undefined,
  env: Record<string, string | undefined>,
  platform: string,
  findBins: (bins: string[]) => string[],
): GatingResult {
  if (metadata === undefined) return { pass: true };
  const oc = metadata.openclaw;
  if (typeof oc !== "object" || oc === null || Array.isArray(oc)) return { pass: true };
  const requires = (oc as Record<string, unknown>).requires;
  if (typeof requires !== "object" || requires === null || Array.isArray(requires)) return { pass: true };
  const r = requires as Record<string, unknown>;
  const always = booleanish(r.always) === true;

  const os = stringArray(r.os);
  if (os !== undefined && os.length > 0 && !os.some((o) => osMatches(platform, o))) {
    return always ? { pass: true } : { pass: false, reason: "os mismatch" };
  }
  const bins = stringArray(r.bins);
  if (bins !== undefined) {
    const found = new Set(findBins(bins));
    for (const b of bins) {
      if (!found.has(b)) return always ? { pass: true } : { pass: false, reason: "missing bin: " + b };
    }
  }
  const anyBins = stringArray(r.anyBins);
  if (anyBins !== undefined && anyBins.length > 0 && findBins(anyBins).length === 0) {
    return always ? { pass: true } : { pass: false, reason: "no anyBins matched" };
  }
  const envs = stringArray(r.env);
  if (envs !== undefined) {
    for (const e of envs) {
      if (!env[e]) return always ? { pass: true } : { pass: false, reason: "missing env: " + e };
    }
  }
  return { pass: true };
}
