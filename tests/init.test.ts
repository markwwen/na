import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { applyInit, planInit } from "../src/project/init.js";
import { loadProjectInstructions } from "../src/project/instructions.js";
import { SkillCatalog } from "../src/project/skills.js";
import { builtinTools } from "../src/tools/builtin.js";
import { Agent } from "../src/agent/agent.js";
import type { SessionSnapshot } from "../src/agent/history.js";
import type { ModelConfig } from "../src/types.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "na-init-test-"));
  const root = join(home, "project");
  await mkdir(root);
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, root };
}
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}
const commandsFile = ".agents/skills/verify-project/references/commands.md";

test("init extracts real script entrypoints without executing or copying script bodies", async t => {
  const { root } = await fixture(t);
  await put(join(root, "package.json"), JSON.stringify({ name: "example", packageManager: "pnpm@10.0.0",
    scripts: { test: "touch SHOULD_NOT_RUN", "test:unit": "test-command", build: "compiler", deploy: "SECRET_DEPLOY_COMMAND", "test:watch": "watch" } }));
  const plan = await planInit(root);
  const commands = plan.files.find(f => f.path === commandsFile)!.content;
  assert.ok(commands.includes("pnpm run test:unit"));
  assert.ok(commands.includes("pnpm run build"));
  assert.ok(!commands.includes("SECRET_DEPLOY_COMMAND"));
  assert.ok(!commands.includes("SHOULD_NOT_RUN"));
  assert.ok(!commands.includes("test:watch"));
  const result = await applyInit(plan);
  assert.deepEqual(result.map(r => r.status), ["created", "created", "created"]);
  assert.ok(!(await readdir(root)).includes("SHOULD_NOT_RUN"));
  const instructions = await loadProjectInstructions(root);
  assert.ok(instructions.prompt.includes("example"));
  const skills = await SkillCatalog.load({ cwd: root, userDirectory: join(root, "absent-home") });
  assert.equal(skills.list()[0]!.name, "verify-project");
  assert.equal(await skills.readResource("verify-project", "references/commands.md"), commands);
});

test("dry-run creates no files or directories; reruns preserve edited files byte-for-byte", async t => {
  const { root } = await fixture(t);
  const plan = await planInit(root);
  assert.equal((await applyInit(plan, true)).length, 3);
  assert.deepEqual(await readdir(root), []);
  await applyInit(plan);
  await put(join(root, "AGENTS.md"), "USER_EDIT\n");
  await put(join(root, commandsFile), "USER_COMMANDS\n");
  assert.ok((await applyInit(await planInit(root))).every(r => r.status === "skipped"));
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "USER_EDIT\n");
  assert.equal(await readFile(join(root, commandsFile), "utf8"), "USER_COMMANDS\n");
});

test("existing Claude/override instruction entrypoints are preserved without introducing a shadowing AGENTS.md", async t => {
  for (const name of ["CLAUDE.md", "AGENTS.override.md"]) {
    const { root } = await fixture(t);
    await put(join(root, name), "EXISTING_GUIDANCE");
    const results = await applyInit(await planInit(root));
    assert.equal(results.find(r => r.path === "AGENTS.md")!.status, "skipped");
    assert.ok(!(await readdir(root)).includes("AGENTS.md"));
    assert.ok((await loadProjectInstructions(root)).prompt.includes("EXISTING_GUIDANCE"));
  }
});

test("unknown/conflicting package managers remain unresolved; explicit declarations win with diagnostics", async t => {
  const { root } = await fixture(t);
  await put(join(root, "package.json"), JSON.stringify({ scripts: { test: "runner" } }));
  let plan = await planInit(root);
  assert.ok(!plan.files.at(-1)!.content.includes("npm run test"));
  assert.ok(plan.files.at(-1)!.content.includes("包管理器未明确"));
  await put(join(root, "package-lock.json"), "{}");
  plan = await planInit(root);
  assert.ok(plan.files.at(-1)!.content.includes("npm run test"));
  await put(join(root, "pnpm-lock.yaml"), "{}");
  plan = await planInit(root);
  assert.ok(!plan.files.at(-1)!.content.includes("npm run test"));
  await put(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { test: "runner" } }));
  plan = await planInit(root);
  assert.ok(plan.files.at(-1)!.content.includes("yarn run test"));
  assert.equal(plan.diagnostics.length, 1);
});

test("Makefile targets are discovered without evaluating make; malformed manifest leaves project untouched", async t => {
  const { root } = await fixture(t);
  await put(join(root, "Makefile"), "test: fixtures\n\t@echo test\nbuild := not-a-target\n# lint:\n");
  const plan = await planInit(root);
  assert.ok(plan.files.at(-1)!.content.includes("make test"));
  assert.ok(!plan.files.at(-1)!.content.includes("make build"));
  assert.ok(!plan.files.at(-1)!.content.includes("make lint"));
  await put(join(root, "package.json"), "{broken");
  await assert.rejects(planInit(root), /package.json 无效/);
  assert.deepEqual((await readdir(root)).sort(), ["Makefile", "package.json"]);
});

test("init skips target symlinks, rejects symlinked parents and never writes outside the project", async t => {
  const { root, home } = await fixture(t);
  const outside = join(home, "outside"); await mkdir(outside);
  await put(join(outside, "instructions"), "PRESERVE");
  await symlink(join(outside, "instructions"), join(root, "AGENTS.md"));
  await symlink(outside, join(root, ".agents"));
  const results = await applyInit(await planInit(root));
  assert.deepEqual(results.map(r => r.status), ["skipped", "error", "error"]);
  assert.equal(await readFile(join(outside, "instructions"), "utf8"), "PRESERVE");
  assert.deepEqual(await readdir(outside), ["instructions"]);
  const preview = await applyInit(await planInit(root), true);
  assert.deepEqual(preview.map(r => r.status), ["skipped", "error", "error"]);
});

test("concurrent init uses no-clobber publication and leaves no temporary files", async t => {
  const { root } = await fixture(t);
  const plan = await planInit(root);
  const results = await Promise.all([applyInit(plan), applyInit(plan)]);
  for (const file of plan.files) {
    assert.equal(results.flat().filter(r => r.path === file.path && r.status === "created").length, 1);
    assert.equal(await readFile(join(root, file.path), "utf8"), file.content);
    assert.ok(!(await readdir(dirname(join(root, file.path)))).some(name => name.startsWith(".na-init-")));
  }
});

test("instructions follow git root to cwd, prefer overrides and do not load unrelated subdirectories", async t => {
  const { root, home } = await fixture(t);
  await put(join(home, "AGENTS.md"), "OUTSIDE_REPOSITORY");
  await mkdir(join(root, ".git"));
  await put(join(root, "AGENTS.md"), "ROOT_GUIDANCE");
  await put(join(root, "src/AGENTS.md"), "REPLACED_GUIDANCE");
  await put(join(root, "src/AGENTS.override.md"), "LOCAL_GUIDANCE");
  await put(join(root, "other/AGENTS.md"), "UNRELATED_GUIDANCE");
  const result = await loadProjectInstructions(join(root, "src"));
  assert.equal(result.files.length, 2);
  assert.ok(result.prompt.indexOf("ROOT_GUIDANCE") < result.prompt.indexOf("LOCAL_GUIDANCE"));
  for (const excluded of ["REPLACED_GUIDANCE", "OUTSIDE_REPOSITORY", "UNRELATED_GUIDANCE"]) assert.ok(!result.prompt.includes(excluded));
});

test("outside a git repository only cwd instructions load; empty override falls back", async t => {
  const { root, home } = await fixture(t);
  await put(join(home, "AGENTS.md"), "PARENT");
  await put(join(root, "AGENTS.override.md"), "\n");
  await put(join(root, "AGENTS.md"), "CURRENT");
  const result = await loadProjectInstructions(root);
  assert.equal(result.files.length, 1);
  assert.ok(result.prompt.includes("CURRENT"));
  assert.ok(!result.prompt.includes("PARENT"));
});

test("instructions fail clearly for outside symlinks, oversized files and cancellation", async t => {
  const { root, home } = await fixture(t);
  await put(join(home, "outside.md"), "OUTSIDE");
  await symlink(join(home, "outside.md"), join(root, "AGENTS.md"));
  await assert.rejects(loadProjectInstructions(root), /项目目录之外/);
  await rm(join(root, "AGENTS.md"));
  await put(join(root, "AGENTS.md"), "a".repeat(24 * 1024 + 1));
  await assert.rejects(loadProjectInstructions(root), /24576/);
  const signal = AbortSignal.abort(new Error("cancel-init"));
  await assert.rejects(planInit(root, signal), /cancel-init/);
  await assert.rejects(applyInit({ root, files: [{ path: "new.md", content: "x" }], diagnostics: [] }, false, signal), /cancel-init/);
  assert.ok(!(await readdir(root)).includes("new.md"));
});

test("environment reload preserves rounds; failed save retains previous environment", async () => {
  const model: ModelConfig = { provider: "mock", id: "mock", thinkingLevel: "off", api: "anthropic-messages",
    baseUrl: "http://mock.invalid", apiKey: "", authHeader: false, headers: {}, maxTokens: 8192, thinkingMode: "budget" };
  let saved: SessionSnapshot | undefined;
  let fail = false;
  const agent = new Agent({
    model, systemPrompt: "OLD", tools: builtinTools,
    save: async state => { if (fail) throw new Error("save-failed"); saved = state; },
    initialState: { messages: [{ role: "system", content: "OLD" }, { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] }] },
  });
  await agent.setEnvironment("CURRENT", builtinTools);
  assert.equal(agent.contextInfo().turns, 1);
  assert.equal(saved!.messages[0]!.content, "CURRENT");
  const before = agent.contextInfo().requestChars;
  fail = true;
  await assert.rejects(agent.setEnvironment("FAILED_NEW_CONTEXT".repeat(100), builtinTools), /save-failed/);
  assert.equal(agent.contextInfo().requestChars, before);
  assert.equal(saved!.messages[1]!.content, "question");
});
