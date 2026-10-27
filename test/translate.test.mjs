import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenClawSkill,
  rewriteBaseDir,
  resolveInvocation,
  evaluateOpenClawGating,
  toSkillName,
} from "../lib/translate.js";

test("parses a standard OpenClaw skill", () => {
  const raw = "---\nname: hello-world\ndescription: A simple skill that prints a greeting.\n---\n\n# Hello World\n\nUse the exec tool.\n";
  const r = parseOpenClawSkill(raw, "hello-world");
  assert.equal(r.error, undefined);
  assert.equal(r.name, "hello-world");
  assert.equal(r.description, "A simple skill that prints a greeting.");
  assert.deepEqual(r.invocation, { modelInvocable: true, userInvocable: true });
  assert.match(r.content, /# Hello World/);
});

test("dirname fallback for missing name", () => {
  const raw = "---\ndescription: No name here.\n---\nbody\n";
  const r = parseOpenClawSkill(raw, "My Skill!");
  assert.equal(r.name, "my-skill");
});

test("invocation mapping (disable-model + user-invocable)", () => {
  const raw = "---\nname: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\nb\n";
  const r = parseOpenClawSkill(raw, "x");
  assert.deepEqual(r.invocation, { modelInvocable: false, userInvocable: false });
});

test("invocation accepts yes/no and 1/0", () => {
  assert.deepEqual(resolveInvocation({ "disable-model-invocation": "yes", "user-invocable": 0 }), { modelInvocable: false, userInvocable: false });
});

test("invalid invocation boolean fails closed", () => {
  const raw = "---\nname: x\ndescription: d\ndisable-model-invocation: maybe\n---\nb\n";
  const r = parseOpenClawSkill(raw, "x");
  assert.ok("error" in r);
});

test("missing description errors", () => {
  const raw = "---\nname: x\n---\nb\n";
  const r = parseOpenClawSkill(raw, "x");
  assert.ok("error" in r);
});

test("baseDir rewrite is verbatim except token", () => {
  assert.equal(rewriteBaseDir("run {baseDir}/scripts/a.sh", "/s/x"), "run /s/x/scripts/a.sh");
});

test("gating: missing bin gates out", () => {
  const md = { openclaw: { requires: { bins: ["definitely-not-a-real-bin-xyz"] } } };
  const g = evaluateOpenClawGating(md, {}, "linux", () => []);
  assert.equal(g.pass, false);
  assert.equal(g.reason, "missing bin: definitely-not-a-real-bin-xyz");
});

test("gating: found bin passes", () => {
  const md = { openclaw: { requires: { bins: ["node"] } } };
  const g = evaluateOpenClawGating(md, {}, "linux", (bins) => bins);
  assert.equal(g.pass, true);
});

test("gating: os mismatch gates out, always overrides", () => {
  const md = { openclaw: { requires: { os: ["darwin"] } } };
  assert.equal(evaluateOpenClawGating(md, {}, "linux", () => []).pass, false);
  const mdAlways = { openclaw: { requires: { os: ["darwin"], always: true } } };
  assert.equal(evaluateOpenClawGating(mdAlways, {}, "linux", () => []).pass, true);
});

test("gating: missing env gates out", () => {
  const md = { openclaw: { requires: { env: ["GEMINI_API_KEY"] } } };
  const g = evaluateOpenClawGating(md, {}, "linux", () => []);
  assert.equal(g.pass, false);
});

test("toSkillName normalizes", () => {
  assert.equal(toSkillName("Hello World!"), "hello-world");
  assert.equal(toSkillName("Foo/Bar_baz"), "foo-bar-baz");
});
