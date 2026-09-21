import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const envModule = new URL("../src/env.ts", import.meta.url).href;
const configModule = new URL("../src/config.ts", import.meta.url).href;
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "na-env-test-"));
  const cwd = join(home, "project with spaces");
  await mkdir(cwd);
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, cwd };
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
}
async function run(cwd: string, body: string, env: NodeJS.ProcessEnv = {}) {
  const code = `import { loadProjectEnv } from ${JSON.stringify(envModule)};\n${body}`;
  const result = await exec(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
    cwd, env: { PATH: process.env.PATH, ...env }, timeout: 10_000,
  });
  return JSON.parse(result.stdout);
}

test("missing .env is optional; parent .env and project .env.local are not loaded", async t => {
  const { home, cwd } = await fixture(t);
  await put(join(home, ".env"), "NA_PARENT_VALUE=parent\n");
  await put(join(cwd, ".env.local"), "NA_LOCAL_VALUE=local\n");
  assert.deepEqual(await run(cwd, `console.log(JSON.stringify({loaded:loadProjectEnv(),parent:process.env.NA_PARENT_VALUE,local:process.env.NA_LOCAL_VALUE}));`), { loaded: false });
});

test("dotenv supports quoted hashes/export; shell syntax and variable references stay literal", async t => {
  const { cwd } = await fixture(t);
  await put(join(cwd, ".env"), [
    "# ignored comment", 'export NA_API_KEY="fake#key$raw"', "NA_ENV_VALUE=hello # comment",
    "NA_ENV_REFERENCE=$NA_ENV_VALUE", "NA_ENV_LITERAL='$(touch SHOULD_NOT_RUN)'", "NA_ENV_EMPTY=", "",
  ].join("\n"));
  const result = await run(cwd, `loadProjectEnv(); console.log(JSON.stringify({key:process.env.NA_API_KEY,value:process.env.NA_ENV_VALUE,reference:process.env.NA_ENV_REFERENCE,literal:process.env.NA_ENV_LITERAL,empty:process.env.NA_ENV_EMPTY}));`);
  assert.deepEqual(result, { key: "fake#key$raw", value: "hello", reference: "$NA_ENV_VALUE", literal: "$(touch SHOULD_NOT_RUN)", empty: "" });
  assert.ok(!(await readdir(cwd)).includes("SHOULD_NOT_RUN"));
});

test("existing environment wins, even empty strings; child processes inherit loaded variables", async t => {
  const { cwd } = await fixture(t);
  await put(join(cwd, ".env"), "NA_API_KEY=file-key\nNA_ENV_EMPTY=file-value\nNA_ENV_CHILD=from-file\n");
  const result = await run(cwd, `
    import { execFileSync } from 'node:child_process';
    loadProjectEnv();
    const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.NA_ENV_CHILD)'], {encoding:'utf8'});
    console.log(JSON.stringify({key:process.env.NA_API_KEY,empty:process.env.NA_ENV_EMPTY,child}));
  `, { NA_API_KEY: "shell-key", NA_ENV_EMPTY: "" });
  assert.deepEqual(result, { key: "shell-key", empty: "", child: "from-file" });
});

test("dotenv participates in config directory selection, credential interpolation and CLI precedence without secret display", async t => {
  const { home, cwd } = await fixture(t);
  const configDir = join(cwd, "config");
  await put(join(configDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "demo", defaultThinkingLevel: "off", env: { NA_API_KEY: "settings-key" } }));
  await put(join(configDir, "models.json"), JSON.stringify({ providers: { mock: {
    api: "anthropic-messages", baseUrl: "http://mock.invalid", apiKey: "$NA_API_KEY", authHeader: true,
    models: [{ id: "demo", reasoning: true, maxTokens: 16384 }],
  } } }));
  await put(join(cwd, ".env"), "NA_CONFIG_DIR=./config\nNA_API_KEY=dotenv-fake-key\nNA_THINKING_LEVEL=low\n");
  const result = await run(cwd, `
    import { ConfigCatalog } from ${JSON.stringify(configModule)};
    loadProjectEnv();
    const options={userDirectory:${JSON.stringify(home)}};
    const catalog=await ConfigCatalog.load({},options);
    const model=catalog.resolve();
    const explicit=(await ConfigCatalog.load({thinking:'off'},options)).resolve();
    console.log(JSON.stringify({key:model.apiKey,thinking:model.thinkingLevel,explicit:explicit.thinkingLevel,description:catalog.describe(model)}));
  `);
  assert.equal(result.key, "dotenv-fake-key");
  assert.equal(result.thinking, "low");
  assert.equal(result.explicit, "off");
  assert.ok(!JSON.stringify(result.description).includes("dotenv-fake-key"));
});

test("invalid env file type/size fails without exposing values; CLI help/version bypass it", async t => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, ".env"));
  const readError = `try { loadProjectEnv(); console.log(JSON.stringify({loaded:true})); } catch(e) { console.log(JSON.stringify({error:e.message})); }`;
  assert.match((await run(cwd, readError)).error, /无法加载/);
  const help = await exec(process.execPath, ["--import", loader, main, "--help"], { cwd, env: { PATH: process.env.PATH }, timeout: 10_000 });
  assert.ok(help.stdout.includes("na - 终端 Coding Agent"));
  const version = await exec(process.execPath, ["--import", loader, main, "--version"], { cwd, env: { PATH: process.env.PATH }, timeout: 10_000 });
  assert.equal(version.stdout.trim(), "0.0.1");
  await rm(join(cwd, ".env"), { recursive: true });
  await put(join(cwd, ".env"), "NA_API_KEY=SECRET_MUST_NOT_LEAK\n" + "#".repeat(128 * 1024));
  const result = await run(cwd, readError);
  assert.match(result.error, /128 KiB/);
  assert.ok(!result.error.includes("SECRET_MUST_NOT_LEAK"));
});
