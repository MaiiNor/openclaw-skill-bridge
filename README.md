# openclaw-skill-bridge

Run [OpenClaw](https://docs.openclaw.ai) skills inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

A DSH skill **provider** that maps OpenClaw skill roots into DSH's `ctx.skills` catalog — so the richer OpenClaw skill ecosystem becomes usable from DSH agents.

---

## Why this exists

OpenClaw and DSH both describe skills as `SKILL.md` files with `name` + `description` YAML frontmatter and a Markdown body. The formats overlap heavily, but the runtimes diverge in ways that drop skills:

| Gap | OpenClaw | DSH |
| --- | --- | --- |
| Discovery depth | nested, up to 6 levels | one level only |
| Skill roots | `workspace/skills`, `~/.openclaw/skills`, workshop, bundled… | `.dsh/skills`, `.agents/skills`, `~/.dsh/skills`, `~/.agents/skills` |
| Resource refs | `{baseDir}` token | `resourceBase` |
| Gating | `metadata.openclaw.requires.*` | none |

This plugin registers an `openclaw` provider that scans OpenClaw roots, flattens nested skills, rewrites `{baseDir}`, and maps gating — so DSH sees them through its own catalog.

## What is lossless — and what is not

**Lossless (byte-for-byte):**

- `name`, `description`, and the instruction body are carried verbatim.
- `disable-model-invocation` / `user-invocable` map 1:1 to DSH's `invocation.modelInvocable` / `invocation.userInvocable`.
- `{baseDir}` is rewritten to the skill directory, published as DSH `resourceBase` (directory kind).
- Nested/grouped discovery is flattened so DSH's one-level catalog sees every skill.

**Not lossless (runtime, not format):**

- Tool references inside a body (`exec`, `browser`, `read`, …) are OpenClaw tool names. The instruction text is preserved, but whether the DSH agent can run them depends on DSH's own tool surface. This plugin does not shim OpenClaw tools.
- `requires.config` gating references `openclaw.json` and is ignored on DSH (carried in `metadata`, never gates). `bins` / `anyBins` / `env` / `os` / `always` are honored when `applyGating` is on.

## Install

Requires a DeepSeek Harness host (`@deepseek-ai/cordis` and `@deepseek-ai/dsh-skill` are peer dependencies).

```bash
npm i openclaw-skill-bridge
```

Then mount the plugin in your DSH composition (same shape as the built-in
`skill-filesystem` provider):

```ts
import openclawSkillBridge from "openclaw-skill-bridge";

// inside your DSH plugin composition
openclawSkillBridge,
```

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `providerName` | `openclaw` | Provider name registered on `ctx.skills`. |
| `includeDefaultRoots` | `true` | Scan workspace, project, personal, managed, and workshop OpenClaw roots. |
| `workspaceDir` | `~/.openclaw/workspace` | OpenClaw workspace. |
| `stateDir` | `$OPENCLAW_STATE_DIR` or `~/.openclaw` | OpenClaw state directory. |
| `agentsHome` | `~/.agents` | Shared agent root. |
| `bundledSkillDir` | — | OpenClaw bundled skills directory (optional). |
| `customSkillDirs` | `[]` | Extra skill roots (rank 700). |
| `maxDepth` | `6` | Max discovery depth (clamped 1–8). |
| `rewriteBaseDir` | `true` | Rewrite `{baseDir}` tokens to the skill directory. |
| `applyGating` | `false` | Enforce OpenClaw `requires.*` gating (except `config`). |
| `watch` | `false` | Reserved; the provider re-scans on each catalog snapshot. |

## Root ranks

Mirrors OpenClaw precedence; lower rank wins on a name collision:

```text
100 workspace · 200 project agents · 300 personal agents · 400 managed
450 workshop · 600 bundled · 700 extra
```

## How it works

`apply()` calls `ctx.skills.registerProvider(...)`, handing DSH a
`SkillProvider` with the standard `list(options)` / `get(candidate, options)`
contract. Discovery walks each root up to `maxDepth`, stops descending when it
finds a `SKILL.md`, parses frontmatter with `yaml`, and emits
`SkillCandidate`s. Loading re-reads the file, rewrites `{baseDir}`, and
returns the DSH `SkillDefinition`.

## Development

```bash
npm install
npm run build   # tsc -p tsconfig.json
npm test        # node --test test/translate.test.mjs
```

## License

MIT
