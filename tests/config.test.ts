import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigCatalog } from "../src/config.js";
import { CONTEXT_LIMITS } from "../src/context.js";
import { MAX_MODEL_CALLS } from "../src/agent.js";
import type { CliOptions } from "../src/cli.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "na-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  await mkdir(configDir);
  const providers = Object.fromEntries(Object.entries({
    glm: ["glm-flash"], deepseek: ["deepseek-flash"],
    multiple: ["one", "two"], first: ["shared"], second: ["shared"],
    hosted: ["org/model"],
  }).map(([name, ids]) => [name, {
    api: "anthropic-messages", baseUrl: "https://example.invalid", apiKey: "fake-private-key",
    models: ids.map(id => ({ id })),
  }]));
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers }));
  await writeFile(join(configDir, "settings.json"), JSON.stringify({
    defaultProvider: "glm", defaultModel: "glm-flash",
  }));
  return {
    providers, root, configDir,
    putSettings: async (value: unknown) => {
      await mkdir(join(root, ".na"), { recursive: true });
      await writeFile(join(root, ".na", "settings.json"), JSON.stringify(value));
    },
    load: (cli: CliOptions = {}, env: NodeJS.ProcessEnv = {}) => ConfigCatalog.load(cli, {
      cwd: root, userDirectory: root, env: { ...env, NA_CONFIG_DIR: configDir },
    }),
  };
}

test("CLI and REPL accept single-model provider shorthand and unique model IDs", async t => {
  const f = await fixture(t);
  for (const selector of ["deepseek", "deepseek-flash", "deepseek/deepseek-flash"]) {
    const cli = await f.load({ model: selector }, { NA_PROVIDER: "glm" });
    assert.equal(cli.resolve().provider, "deepseek");
    const repl = await f.load({ provider: "glm", model: "glm-flash" }, { NA_PROVIDER: "glm" });
    const model = repl.resolve({ model: selector });
    assert.equal(model.provider, "deepseek");
    assert.equal(model.id, "deepseek-flash");
  }
});

test("defaults, explicit provider constraints and saved selections remain effective", async t => {
  const f = await fixture(t);
  const defaults = await f.load();
  assert.equal(defaults.resolve().provider, "glm");
  assert.equal(defaults.resolve({ provider: "deepseek", model: "deepseek-flash" }).provider, "deepseek");
  const constrained = await f.load({ provider: "glm", model: "deepseek-flash" });
  assert.throws(() => constrained.resolve(), /未找到模型/);
  const conflicting = await f.load({ provider: "glm", model: "deepseek/deepseek-flash" });
  assert.throws(() => conflicting.resolve(), /前缀冲突/);
  assert.throws(() => defaults.resolve({ provider: "sglang", model: "deepseek-flash" }), /未找到模型/);
});

test("ambiguous provider/model names and unknown selectors show usable choices", async t => {
  const f = await fixture(t);
  const catalog = await f.load();
  assert.throws(() => catalog.resolve({ model: "multiple" }), /模型不唯一.*multiple\/one.*multiple\/two/);
  assert.throws(() => catalog.resolve({ model: "shared" }), /模型不唯一.*first\/shared.*second\/shared/);
  assert.throws(() => catalog.resolve({ model: "missing" }), error => {
    const message = (error as Error).message;
    assert.match(message, /未找到模型.*missing.*deepseek\/deepseek-flash/);
    assert.ok(!message.includes("fake-private-key"));
    return true;
  });
});

test("contextLimits override defaults field by field and reject invalid input", async t => {
  const f = await fixture(t);
  const put = f.putSettings;

  const defaults = await f.load();
  assert.deepEqual(defaults.contextLimits(), { ...CONTEXT_LIMITS });
  assert.deepEqual(defaults.describe(defaults.resolve()).contextLimits, { ...CONTEXT_LIMITS });

  await put({ contextLimits: { keepTurns: 5, batchChars: 2000 } });
  assert.deepEqual((await f.load()).contextLimits(), { ...CONTEXT_LIMITS, keepTurns: 5, batchChars: 2000 });

  // 全局与项目配置按字段合并，未写出的字段保留默认值。
  await writeFile(join(f.configDir, "settings.json"), JSON.stringify({
    defaultProvider: "glm", defaultModel: "glm-flash",
    contextLimits: { maxSummaryChars: 500 },
  }));
  assert.deepEqual((await f.load()).contextLimits(), {
    maxInputChars: CONTEXT_LIMITS.maxInputChars, keepTurns: 5, maxSummaryChars: 500, batchChars: 2000,
    reserveTokens: CONTEXT_LIMITS.reserveTokens,
  });

  await put({ contextLimits: { keepTurns: 5, unknown: 1 } });
  await assert.rejects(f.load(), /contextLimits.unknown 不是可配置项/);
  await put({ contextLimits: { batchChars: 999 } });
  await assert.rejects(f.load(), /contextLimits.batchChars 必须是 1000～/);
  await put({ contextLimits: { keepTurns: 1.5 } });
  await assert.rejects(f.load(), /contextLimits.keepTurns 必须是 0～/);
  await put({ contextLimits: { maxInputChars: 6000 } });
  await assert.rejects(f.load(), /contextLimits.maxInputChars 至少为 batchChars \+ maxSummaryChars \+ 4000/);
  await put({ contextLimits: 1 });
  await assert.rejects(f.load(), /contextLimits 必须是对象/);
});

test("maxModelCalls overrides the per-turn model request cap", async t => {
  const f = await fixture(t);
  const defaults = await f.load();
  assert.equal(defaults.maxModelCalls(), MAX_MODEL_CALLS);
  assert.equal(defaults.describe(defaults.resolve()).maxModelCalls, MAX_MODEL_CALLS);

  await f.putSettings({ maxModelCalls: 3 });
  assert.equal((await f.load()).maxModelCalls(), 3);

  await f.putSettings({ maxModelCalls: 0 });
  assert.equal((await f.load()).maxModelCalls(), 0);
  await f.putSettings({ maxModelCalls: -1 });
  await assert.rejects(f.load(), /maxModelCalls 必须是 0～/);
  await f.putSettings({ maxModelCalls: 2.5 });
  await assert.rejects(f.load(), /maxModelCalls 必须是 0～/);
  await f.putSettings({ maxModelCalls: "5" });
  await assert.rejects(f.load(), /maxModelCalls 必须是 0～/);
});

test("model windows and output reserve are resolved and validated", async t => {
  const f = await fixture(t);
  assert.equal((await f.load()).resolve().contextWindow, 500000);
  Object.assign(f.providers.glm!.models[0]!, { contextWindow: 8192 });
  await writeFile(join(f.configDir, "models.json"), JSON.stringify({ providers: f.providers }));
  const invalid = await f.load();
  assert.throws(() => invalid.resolve(), /contextWindow 太小/);
  await f.putSettings({ contextLimits: { reserveTokens: 2048 } });
  const valid = await f.load();
  assert.equal(valid.resolve().contextWindow, 8192);
  assert.equal(valid.describe(valid.resolve()).contextWindow, 8192);
  await f.putSettings({ contextLimits: { reserveTokens: -1 } });
  await assert.rejects(f.load(), /reserveTokens 必须是 0～/);
  await f.putSettings({ contextLimits: { toString: 2 } });
  await assert.rejects(f.load(), /toString 不是可配置项/);
  await f.putSettings({});
  Object.assign(f.providers.glm!.models[0]!, { contextWindow: "8192" });
  await writeFile(join(f.configDir, "models.json"), JSON.stringify({ providers: f.providers }));
  const badType = await f.load();
  assert.throws(() => badType.resolve(), /model.contextWindow 必须/);
});

test("exact IDs take precedence over provider shorthand and retain embedded slashes", async t => {
  const f = await fixture(t);
  f.providers.hosted!.models.push({ id: "deepseek" }, { id: "glm/model" });
  await writeFile(join(f.configDir, "models.json"), JSON.stringify({ providers: f.providers }));
  const catalog = await f.load();
  assert.equal(catalog.resolve({ model: "deepseek" }).provider, "hosted");
  assert.equal(catalog.resolve({ model: "org/model" }).id, "org/model");
  assert.equal(catalog.resolve({ model: "glm/model" }).provider, "hosted");
  assert.equal(catalog.resolve({ model: "deepseek/deepseek-flash" }).provider, "deepseek");
});
