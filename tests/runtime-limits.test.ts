import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("REPL reports active limits after /model, applies /reload atomically and restores sessions with current limits", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "na-runtime-limits-"));
  const settings = join(root, "settings.json");
  const put = (maxInputChars: number, maxModelCalls: number, reserveTokens = 16384) => writeFile(settings,
    JSON.stringify({ defaultProvider: "mock", defaultModel: "mock", maxModelCalls, contextLimits: { maxInputChars, reserveTokens } }));
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { mock: {
    api: "anthropic-messages", baseUrl: "http://mock.invalid", models: [{ id: "mock", contextWindow: 64000 }],
  } } }));
  await put(480000, 0);
  const child = spawn(process.execPath, ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--no-skills"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, NA_CONFIG_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const prompt = async () => {
    for (let i = 0; i < 500; i++) {
      if (output.endsWith("> ")) {
        const result = output.slice(0, -2).trim(); output = ""; return result;
      }
      if (child.exitCode !== null) throw new Error(`REPL exited: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`REPL timeout: ${errors}\n${output}`);
  };
  const command = async (text: string) => { child.stdin.write(text + "\n"); return prompt(); };
  try {
    const startup = await prompt();
    const sessionId = /sessions\/(.*?)\.json/.exec(startup)?.[1];
    assert.ok(sessionId);
    await put(60000, 3, 4096);
    await command("/model");
    const before = JSON.parse(await command("/config"));
    assert.equal(before.contextLimits.maxInputChars, 480000);
    assert.equal(before.maxModelCalls, 0);
    assert.match(await command("/context"), /480000/);
    await command("/reload");
    const after = JSON.parse(await command("/config"));
    assert.equal(after.contextLimits.maxInputChars, 60000);
    assert.equal(after.contextLimits.reserveTokens, 4096);
    assert.equal(after.maxModelCalls, 3);
    assert.match(await command("/context"), /59904/);
    await put(60000, 7, 64000);
    await command("/reload");
    assert.deepEqual(JSON.parse(await command("/config")), after);
    await put(60000, 0, 4096);
    await command(`/resume ${sessionId}`);
    const resumed = JSON.parse(await command("/config"));
    assert.equal(resumed.maxModelCalls, 0);
    assert.equal(resumed.contextWindow, 64000);
    assert.equal(resumed.contextLimits.reserveTokens, 4096);
    child.stdin.write("/quit\n");
    const [code] = await exit;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await exit; }
    await rm(root, { recursive: true, force: true });
  }
});
