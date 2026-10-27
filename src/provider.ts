import { readFile, readdir, stat } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillProviderObservation,
} from "@deepseek-ai/dsh-skill";
import {
  parseOpenClawSkill,
  rewriteBaseDir,
  evaluateOpenClawGating,
} from "./translate.js";

export interface OpenClawSkillRoot {
  readonly path: string;
  readonly source: string;
  readonly rank: number;
}

export interface Config {
  providerName?: string;
  includeDefaultRoots?: boolean;
  workspaceDir?: string;
  stateDir?: string;
  agentsHome?: string;
  bundledSkillDir?: string;
  customSkillDirs?: string[];
  maxDepth?: number;
  rewriteBaseDir?: boolean;
  applyGating?: boolean;
  watch?: boolean;
}

interface Locator {
  readonly path: string;
  readonly directory: string;
}

const DEFAULT_MAX_DEPTH = 6;

export class OpenClawSkillProvider implements SkillProvider {
  readonly name: string;
  private readonly ctx: Context;
  private readonly includeDefaultRoots: boolean;
  private readonly workspaceDir?: string;
  private readonly stateDir?: string;
  private readonly agentsHome?: string;
  private readonly bundledSkillDir?: string;
  private readonly customSkillDirs: string[];
  private readonly maxDepth: number;
  private readonly rewriteBaseDirFlag: boolean;
  private readonly applyGating: boolean;
  private readonly control: SkillProviderControl;

  constructor(ctx: Context, control: SkillProviderControl, config: Config = {}) {
    this.ctx = ctx;
    this.control = control;
    this.name = config.providerName ?? "openclaw";
    this.includeDefaultRoots = config.includeDefaultRoots ?? true;
    this.workspaceDir = config.workspaceDir;
    this.stateDir = config.stateDir;
    this.agentsHome = config.agentsHome;
    this.bundledSkillDir = config.bundledSkillDir;
    this.customSkillDirs = (config.customSkillDirs ?? []).map((p) => resolve(p));
    const d = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxDepth = Math.min(8, Math.max(1, Math.floor(d)));
    this.rewriteBaseDirFlag = config.rewriteBaseDir ?? true;
    this.applyGating = config.applyGating ?? false;
    control.signal.addEventListener("abort", () => { this.dispose(); }, { once: true });
  }

  invalidate(): void {
    this.control.invalidate();
  }

  dispose(): void {
    // No watchers in this minimal provider; kept for teardown parity.
  }

  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    const roots = await this.resolveRoots(options.cwd);
    const candidates: SkillCandidate[] = [];
    let complete = true;
    for (const root of roots) {
      try {
        candidates.push(...(await this.discoverRoot(root)));
      } catch (e) {
        this.ctx.logger.warn("openclaw-skill-bridge: discovery failed for " + root.path + ": " + String(e));
        complete = false;
      }
    }
    return complete ? candidates : { candidates, complete };
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as Locator;
    const raw = await this.readText(locator.path, options.signal);
    if (raw === undefined) return undefined;
    const parsed = parseOpenClawSkill(raw, basename(locator.directory));
    if ("error" in parsed) return undefined;
    const content = this.rewriteBaseDirFlag ? rewriteBaseDir(parsed.content, locator.directory) : parsed.content;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: "directory", path: locator.directory },
      path: locator.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      content,
    };
  }

  private async resolveRoots(cwd?: string): Promise<OpenClawSkillRoot[]> {
    const roots: OpenClawSkillRoot[] = [];
    if (this.includeDefaultRoots) {
      const workspace = resolve(this.workspaceDir ?? join(homedir(), ".openclaw", "workspace"));
      const stateDir = resolve(this.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"));
      const agentsHome = resolve(this.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents"));
      roots.push({ path: join(workspace, "skills"), source: "openclaw-workspace", rank: 100 });
      roots.push({ path: join(workspace, ".agents", "skills"), source: "openclaw-project", rank: 200 });
      roots.push({ path: join(agentsHome, "skills"), source: "openclaw-personal", rank: 300 });
      roots.push({ path: join(stateDir, "skills"), source: "openclaw-managed", rank: 400 });
      for (const ws of await this.listWorkshopDirs(stateDir)) {
        roots.push({ path: ws, source: "openclaw-workshop", rank: 450 });
      }
      if (this.bundledSkillDir !== undefined) {
        roots.push({ path: resolve(this.bundledSkillDir), source: "openclaw-bundled", rank: 600 });
      }
    }
    for (const d of this.customSkillDirs) {
      roots.push({ path: d, source: "openclaw-extra", rank: 700 });
    }
    return roots;
  }

  private async listWorkshopDirs(stateDir: string): Promise<string[]> {
    const agentsBase = join(stateDir, "agents");
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(agentsBase, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const ws = join(agentsBase, e.name, "agent", "workshop-skills");
      if (await this.isDir(ws)) out.push(ws);
    }
    return out;
  }

  private async discoverRoot(root: OpenClawSkillRoot): Promise<SkillCandidate[]> {
    const out: SkillCandidate[] = [];
    await this.walk(root, root.path, 0, out);
    return out;
  }

  private async walk(root: OpenClawSkillRoot, dir: string, depth: number, out: SkillCandidate[]): Promise<void> {
    if (depth > this.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isAbsent(e)) return;
      throw e;
    }
    for (const entry of entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = join(full, "SKILL.md");
        if (await this.isFile(skillFile)) {
          const cand = await this.buildCandidate(skillFile, full, root);
          if (cand !== undefined) out.push(cand);
          continue; // OpenClaw: a SKILL.md ends traversal below that directory
        }
        await this.walk(root, full, depth + 1, out);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md" && depth === 0) {
        const cand = await this.buildCandidate(full, dir, root);
        if (cand !== undefined) out.push(cand);
      }
    }
  }

  private async buildCandidate(filePath: string, directory: string, root: OpenClawSkillRoot): Promise<SkillCandidate | undefined> {
    const raw = await this.readText(filePath);
    if (raw === undefined) return undefined;
    const parsed = parseOpenClawSkill(raw, basename(directory));
    if ("error" in parsed) {
      this.ctx.logger.warn("openclaw-skill-bridge: " + filePath + " skipped: " + parsed.error);
      return undefined;
    }
    if (!isSkillName(parsed.name)) {
      this.ctx.logger.warn("openclaw-skill-bridge: " + filePath + " skipped: invalid skill name " + JSON.stringify(parsed.name));
      return undefined;
    }
    if (this.applyGating) {
      const g = evaluateOpenClawGating(parsed.metadata, process.env, process.platform, this.findBins.bind(this));
      if (!g.pass) {
        this.ctx.logger.warn("openclaw-skill-bridge: " + filePath + " gated out: " + (g.reason ?? "unknown"));
        return undefined;
      }
    }
    const locator: Locator = { path: filePath, directory };
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: root.source,
      provider: this.name,
      rank: root.rank,
      locator,
      resourceBase: { kind: "directory", path: directory },
      path: filePath,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
  }

  private findBins(bins: string[]): string[] {
    const pathDirs = (process.env.PATH ?? "").split(":");
    const found: string[] = [];
    for (const bin of bins) {
      for (const dir of pathDirs) {
        const full = join(dir, bin);
        try {
          accessSync(full, fsConstants.X_OK);
          found.push(bin);
          break;
        } catch {
          /* keep looking */
        }
      }
    }
    return found;
  }

  private async readText(path: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    try {
      return await readFile(path, { encoding: "utf8", signal });
    } catch (e) {
      if (isAbsent(e)) return undefined;
      throw e;
    }
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  private async isDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}

function isAbsent(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e &&
    ((e as { code?: string }).code === "ENOENT" || (e as { code?: string }).code === "ENOTDIR");
}
