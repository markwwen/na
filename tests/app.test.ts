import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app.js";
import { ConfigCatalog } from "../src/config/config.js";
import { SessionStore } from "../src/session/store.js";

test("application state survives failed saves during model changes, reloads and session switches", async t => {
  const root = await mkdtemp(join(tmpdir(), "na-app-"));
  const previousCwd = process.cwd();
  process.chdir(root);
  t.after(async () => { process.chdir(previousCwd); await rm(root, { recursive: true, force: true }); });
  const load = ConfigCatalog.load;
  t.mock.method(ConfigCatalog, "load", cli => load.call(ConfigCatalog, cli, {
    cwd: root, userDirectory: root, env: { NA_CONFIG_DIR: root },
  }));
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { mock: {
    api: "anthropic-messages", baseUrl: "http://mock.invalid", models: [
      { id: "mock", reasoning: true, maxTokens: 8192, contextWindow: 64000 },
      { id: "other", reasoning: true, maxTokens: 8192, contextWindow: 64000 },
    ],
  } } }));
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ defaultProvider: "mock", defaultModel: "mock" }));
  await writeFile(join(root, "AGENTS.md"), "ORIGINAL_GUIDANCE");
  const skillRoot = join(root, "skills");
  await mkdir(skillRoot);
  const app = await App.create({ noSkills: true, skillPaths: [skillRoot] });
  const other = await SessionStore.create("other", "other prompt", { provider: "mock", id: "other", thinkingLevel: "off" });
  const snapshot = () => ({ session: app.sessionInfo, model: app.modelLabel,
    config: app.configuration(), project: app.projectInfo, context: app.contextInfo() });
  const before = snapshot();
  const archived = await readFile(app.sessionInfo.filePath, "utf8");

  const save = SessionStore.prototype.save;
  let fail = true;
  t.mock.method(SessionStore.prototype, "save", async function (this: SessionStore, state) {
    if (fail) throw new Error("save-failed");
    return save.call(this, state);
  });
  await writeFile(settings, JSON.stringify({ defaultProvider: "mock", defaultModel: "other", maxModelCalls: 3 }));
  await writeFile(join(root, "AGENTS.md"), "UPDATED_GUIDANCE");
  await mkdir(join(skillRoot, "review"));
  await writeFile(join(skillRoot, "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview the changes.");

  for (const operation of [
    () => app.selectModel("mock/other"), () => app.setThinking("low"), () => app.reload(),
    () => app.resume(other.id), () => app.newSession(),
  ]) {
    await assert.rejects(operation(), /save-failed/);
    assert.deepEqual(snapshot(), before);
    assert.equal(await readFile(app.sessionInfo.filePath, "utf8"), archived);
  }
  await assert.rejects(app.reload(AbortSignal.abort(new Error("cancel-reload"))), /cancel-reload/);
  assert.deepEqual(snapshot(), before);

  const requests: { model: string; system: string; tools: { name: string }[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const events = [
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  fail = false;
  await app.prompt("continue after failure");
  assert.equal(requests[0].model, "mock");
  assert.match(requests[0].system, /ORIGINAL_GUIDANCE/);
  assert.doesNotMatch(requests[0].system, /UPDATED_GUIDANCE/);
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ["read_file", "list_files", "write_file", "edit_file", "run_command"]);

  await app.reload();
  assert.equal(app.sessionInfo.id, before.session.id);
  assert.equal(app.modelLabel, before.model);
  assert.equal(app.contextInfo().turns, 1);
  assert.equal(app.runtimeLimits().maxModelCalls, 3);
  assert.deepEqual(app.projectInfo.skills.map(skill => skill.name), ["review"]);
  await app.prompt("continue after reload");
  assert.match(requests[1].system, /UPDATED_GUIDANCE/);
  assert.ok(requests[1].tools.some(tool => tool.name === "load_skill"));
  await app.selectModel("mock/other");
  assert.match(app.modelLabel, /^mock\/other/);
  await app.resume(before.session.id);
  assert.equal(app.contextInfo().turns, 2);
  assert.match(app.modelLabel, /^mock\/other/);
  await app.newSession();
  assert.notEqual(app.sessionInfo.id, before.session.id);
  assert.equal(app.contextInfo().turns, 0);
  assert.match(app.modelLabel, /^mock\/other/);
});
