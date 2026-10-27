import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { OpenClawSkillProvider, type Config as ProviderConfig } from "./provider.js";

export const name = "openclaw-skill-bridge";
export const inject = ["skills"];

export const Config = z.object({
  providerName: z.string().min(1).default("openclaw"),
  includeDefaultRoots: z.boolean().default(true),
  workspaceDir: z.string(),
  stateDir: z.string(),
  agentsHome: z.string(),
  bundledSkillDir: z.string(),
  customSkillDirs: z.array(z.string()).default([]),
  maxDepth: z.number().default(6),
  rewriteBaseDir: z.boolean().default(true),
  applyGating: z.boolean().default(false),
  watch: z.boolean().default(false),
});

/** Register the OpenClaw skill provider on ctx.skills. */
export function apply(ctx: Context, config: ProviderConfig = {}): void {
  let provider: OpenClawSkillProvider;
  ctx.skills.registerProvider((control) => {
    provider = new OpenClawSkillProvider(ctx, control, config);
    return provider;
  });
  ctx.effect(function* () {
    yield async () => {
      provider.dispose();
    };
  }, "openclaw-skill-bridge lifecycle");
}
