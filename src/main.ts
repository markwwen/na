#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { App } from "./app.js";
import { HELP, parseArgs } from "./cli/args.js";
import { createStreamPrinter } from "./cli/renderer.js";
import { runRepl } from "./cli/repl.js";
import { loadProjectEnv } from "./config/env.js";

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) { console.log(HELP); return; }
  if (cli.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version); return;
  }
  loadProjectEnv();
  const streamPrinter = createStreamPrinter();
  const app = await App.create(cli, {
    onToolCall: call => {
      streamPrinter.finish();
      console.log(`[tool] ${call.name} ${JSON.stringify(call.input)}`);
    },
    onStream: streamPrinter.onEvent,
    onNotice: text => {
      streamPrinter.finish();
      console.log(`[context] ${text}`);
    },
  });
  await runRepl(app, cli, streamPrinter);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
