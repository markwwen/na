import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigCatalog } from "../src/config.js";
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
    providers, configDir,
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
