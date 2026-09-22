import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";
import { Agent } from "../src/agent/agent.js";
import type { AgentTool, ModelConfig, ToolUseBlock } from "../src/types.js";

const tool: AgentTool = { name: "custom", description: "custom tool", input_schema: { type: "object" },
  execute: async () => "custom result" };
const call: ToolUseBlock = { type: "tool_use", id: "call-1", name: "custom", input: {} };

test("registry advertises and executes exactly its tools and returns ordinary failures to the model", async () => {
  assert.throws(() => new ToolRegistry([tool, tool]), /工具重名/);
  const registry = new ToolRegistry([tool]);
  assert.deepEqual(registry.definitions, [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }]);
  assert.deepEqual(await registry.execute(call), { type: "tool_result", tool_use_id: call.id, content: "custom result" });
  const missing = await registry.execute({ ...call, name: "run_command" });
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /未知工具/);
  const failure = new ToolRegistry([{ ...tool, execute: async () => { throw new Error("tool-failed"); } }]);
  assert.deepEqual(await failure.execute(call), {
    type: "tool_result", tool_use_id: call.id, content: "tool-failed", is_error: true,
  });
});

test("registry cancellation waits for tool cleanup and propagates the cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel-test");
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  let cleaned = false;
  const registry = new ToolRegistry([{ ...tool, execute: async () => {
    controller.abort(reason);
    await cleanup;
    cleaned = true;
    return "done";
  } }]);
  let settled = false;
  const result = registry.execute(call, controller.signal);
  const rejected = assert.rejects(result, error => { settled = true; return error === reason; });
  await Promise.resolve();
  assert.equal(settled, false);
  finishCleanup();
  await rejected;
  assert.equal(cleaned, true);
});

test("failed environment saves keep the tools advertised to the model and their execution unchanged", async t => {
  const model: ModelConfig = { provider: "mock", id: "mock", thinkingLevel: "off", api: "anthropic-messages",
    baseUrl: "http://mock.invalid", apiKey: "", authHeader: false, headers: {}, maxTokens: 8192, thinkingMode: "budget" };
  let fail = true;
  let executed = "";
  const original = { ...tool, execute: async () => { executed = "original"; return executed; } };
  const replacement = { ...tool, description: "replacement", execute: async () => { executed = "replacement"; return executed; } };
  const agent = new Agent({ model, systemPrompt: "system", tools: [original],
    save: async () => { if (fail) throw new Error("save-failed"); } });
  await assert.rejects(agent.setEnvironment("new", [replacement]), /save-failed/);
  fail = false;
  let expected = original;
  let request = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.tools, [{ name: expected.name, description: expected.description, input_schema: expected.input_schema }]);
    const useTool = request++ % 2 === 0;
    if (!useTool) assert.equal(body.messages.at(-1).content[0].content, executed);
    const events = [
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: useTool ? call : { type: "text", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn" } }, { type: "message_stop" },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  await agent.prompt("before reload");
  assert.equal(executed, "original");
  await agent.setEnvironment("new", [replacement]);
  expected = replacement;
  await agent.prompt("after reload");
  assert.equal(executed, "replacement");
});
