import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinTools } from "../src/tools/builtin.js";
import { Agent } from "../src/agent/agent.js";
import { calibrateUsage, estimateInputTokens, fitOutputBudget } from "../src/agent/budget.js";
import { callLLM } from "../src/llm/client.js";
import { ContextManager } from "../src/agent/context.js";
import { CONTEXT_LIMITS } from "../src/agent/runtime-limits.js";
import { readMessageStream } from "../src/llm/stream.js";
import type { SessionSnapshot } from "../src/agent/history.js";
import type { AssistantMessage, Message, ModelConfig } from "../src/types.js";

const model: ModelConfig = { provider: "mock", id: "mock", thinkingLevel: "off", api: "anthropic-messages",
  baseUrl: "http://mock.invalid", apiKey: "", authHeader: false, headers: {}, maxTokens: 8192,
  contextWindow: 128000, thinkingMode: "budget" };
const text = (value: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: value }] });
const usage = { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 2000, cacheCreationTokens: 3000 };
const limits = { ...CONTEXT_LIMITS, maxSummaryChars: 100, batchChars: 1000, reserveTokens: 2048 };

function response(content: AssistantMessage["content"], stopReason = "end_turn", startUsage?: unknown, deltas: unknown[] = []) {
  const events: unknown[] = [{ type: "message_start", message: { role: "assistant", content: [], usage: startUsage } }];
  content.forEach((block, index) => events.push({ type: "content_block_start", index, content_block: block },
    { type: "content_block_stop", index }));
  for (const usage of deltas) events.push({ type: "message_delta", delta: {}, usage });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason } }, { type: "message_stop" });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

test("stream usage merges cumulative fields, includes cache counts and tolerates missing/invalid usage", async () => {
  const r = await readMessageStream(response(text("ok").content, "end_turn",
    { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
    [{ output_tokens: 5 }, { input_tokens: 120, output_tokens: 10 }]).body!);
  assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 300 });
  assert.equal((await readMessageStream(response(text("ok").content).body!)).usage, undefined);
  assert.equal((await readMessageStream(response(text("ok").content, "end_turn",
    { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: -1 }, [{ output_tokens: 5 }]).body!)).usage, undefined);
  assert.equal((await readMessageStream(response(text("ok").content, "end_turn",
    { input_tokens: 10, output_tokens: 1 }).body!)).usage, undefined);
  assert.equal((await readMessageStream(response(text("ok").content, "end_turn",
    { input_tokens: 10, output_tokens: 1 }, ["invalid"]).body!)).usage, undefined);
});

test("usage calibrates unchanged prefixes and estimates appended messages; changed context invalidates it", () => {
  const messages: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "question" }, text("answer")];
  const calibration = calibrateUsage(model, messages, [], usage)!;
  assert.deepEqual(estimateInputTokens(model, messages, [], calibration), { tokens: 15100, source: "usage" });
  const next: Message[] = [...messages, { role: "user", content: "next question" }];
  const estimate = estimateInputTokens(model, next, [], calibration);
  assert.equal(estimate.source, "usage");
  assert.ok(estimate.tokens > 15100);
  for (const changed of [messages.slice(1), [{ role: "system", content: "changed" } as Message, ...messages.slice(1)]]) {
    assert.equal(estimateInputTokens(model, changed, [], calibration).source, "estimate");
  }
  assert.equal(estimateInputTokens({ ...model, id: "other" }, next, [], calibration).source, "estimate");
  assert.equal(estimateInputTokens(model, next, [{ name: "new", description: "new", input_schema: {} }], calibration).source, "estimate");
  assert.equal(calibrateUsage(model, messages, [], { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), undefined);
  const thinking: Message[] = [...messages.slice(0, 2), { role: "assistant", content: [
    { type: "thinking", thinking: "thought", signature: "signature" }, { type: "text", text: "answer" },
  ] }];
  const old = calibrateUsage(model, thinking, [], usage);
  assert.equal(estimateInputTokens(model, [...thinking, next.at(-1)!], [], old).source, "estimate");
  assert.ok(estimateInputTokens(model, [{ role: "user", content: "中".repeat(1000) }], []).tokens >= 1000);
});

test("request output fits remaining window, clamps thinking and sends no bookkeeping metadata", async t => {
  let body: { max_tokens: number; thinking: { budget_tokens: number }; contextWindow?: number };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return response(text("ok").content);
  });
  const thinking = { ...model, contextWindow: 10000, maxTokens: 8192, thinkingLevel: "high" as const, thinkingBudget: 6000 };
  await callLLM(thinking, [{ role: "user", content: "question" }], [], undefined, undefined, 5000);
  assert.equal(body!.max_tokens, 3976);
  assert.equal(body!.thinking.budget_tokens, 2952);
  assert.equal(thinking.maxTokens, 8192);
  assert.equal(body!.contextWindow, undefined);
  assert.throws(() => fitOutputBudget(thinking, 8000), /无法预留/);
});

test("token threshold compacts complete history even below the character limit", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(text("summary").content); });
  const messages: Message[] = [{ role: "system", content: "system" },
    { role: "user", content: "a".repeat(1000) }, text("old answer"), { role: "user", content: "current" }];
  const smallModel = { ...model, contextWindow: 8000 };
  const c = new ContextManager(smallModel, "system", [], undefined, undefined, { ...limits, keepTurns: 0 });
  c.observe(messages.slice(0, 3), { ...usage, inputTokens: 7000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.ok(c.size(c.render(messages)) < limits.maxInputChars);
  const prepared = await c.prepare(messages, undefined, { pendingTurn: true });
  assert.equal(c.checkpoint.through, 3);
  assert.equal(c.checkpoint.summary, "summary");
  assert.ok(calls >= 1);
  assert.equal(c.estimate(prepared).source, "estimate");
  assert.ok(c.estimate(prepared).tokens <= 8000 - limits.reserveTokens);
  assert.equal(messages[1]!.content, "a".repeat(1000));
});

test("smaller budgets reject an oversized old summary without sending an oversized request", async () => {
  const messages: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "old" }, text("old answer"),
    { role: "user", content: "new" }];
  const c = new ContextManager(model, "system", [], { through: 3, summary: "摘".repeat(5900) }, undefined,
    { ...limits, maxInputChars: 5100, keepTurns: 0 });
  await assert.rejects(c.prepare(messages, undefined, { pendingTurn: true }), /已有摘要超过/);
  assert.equal(c.checkpoint.summary.length, 5900);
});

test("default agent can finish beyond 20 model calls and archives only the complete round", async t => {
  let calls = 0;
  let toolCalls = 0;
  let saved: SessionSnapshot | undefined;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls <= 24 ? response([{ type: "tool_use", id: `call-${calls}`, name: "noop", input: {} }], "tool_use")
      : response(text("done").content);
  });
  const agent = new Agent({
    model, systemPrompt: "system", save: async state => { saved = state; },
    tools: [...builtinTools, { name: "noop", description: "noop", input_schema: {},
      execute: async () => { toolCalls++; return "ok"; } }],
  });
  assert.equal(await agent.prompt("long task"), "done");
  assert.equal(calls, 25);
  assert.equal(toolCalls, 24);
  assert.equal(agent.contextInfo().turns, 1);
  assert.equal(saved!.messages.length, 51);
});

test("explicit call cap and user cancellation stop without saving a partial round", async t => {
  let calls = 0;
  let saves = 0;
  const controller = new AbortController();
  let cancel = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response([{ type: "tool_use", id: `call-${calls}`, name: "noop", input: {} }], "tool_use");
  });
  const agent = new Agent({
    model, systemPrompt: "system", save: async () => { saves++; },
    tools: [...builtinTools, { name: "noop", description: "noop", input_schema: {}, execute: async () => {
      if (cancel) controller.abort(new Error("cancel-test")); return "ok";
    } }],
    limits: CONTEXT_LIMITS, maxModelCalls: 2,
  });
  await assert.rejects(agent.prompt("task"), /2 次模型请求上限/);
  assert.equal(calls, 2);
  assert.equal(saves, 0);
  agent.setLimits(CONTEXT_LIMITS, 0);
  cancel = true;
  await assert.rejects(agent.prompt("task", controller.signal), /cancel-test/);
  assert.equal(calls, 3);
  assert.equal(saves, 0);
  assert.equal(agent.contextInfo().turns, 0);
});

test("usage is committed with successful rounds, retained for missing usage and invalidated on environment/model changes", async t => {
  let reportUsage = true;
  t.mock.method(globalThis, "fetch", async () => response(text("done").content, "end_turn",
    reportUsage ? { input_tokens: 10000, output_tokens: 1 } : undefined,
    reportUsage ? [{ output_tokens: 100 }] : []));
  let fail = false;
  const agent = new Agent({
    model, systemPrompt: "system", tools: builtinTools,
    save: async () => { if (fail) throw new Error("save-failed"); },
  });
  await agent.prompt("question");
  assert.equal(agent.contextInfo().requestTokens, 10100);
  assert.equal(agent.contextInfo().tokenSource, "usage");
  reportUsage = false;
  await agent.prompt("missing usage");
  assert.equal(agent.contextInfo().tokenSource, "usage");
  assert.ok(agent.contextInfo().requestTokens > 10100);
  reportUsage = true;
  const snapshot = agent.contextInfo();
  fail = true;
  await assert.rejects(agent.prompt("next"), /save-failed/);
  assert.deepEqual(agent.contextInfo(), snapshot);
  await assert.rejects(agent.setEnvironment("new", builtinTools, undefined, limits, 3), /save-failed/);
  assert.deepEqual(agent.contextInfo(), snapshot);
  fail = false;
  await agent.setEnvironment("new", builtinTools, undefined, limits, 3);
  assert.equal(agent.contextInfo().tokenSource, "estimate");
  assert.equal(agent.contextInfo().reserveTokens, 2048);
  assert.equal(agent.contextInfo().maxModelCalls, 3);
  await agent.prompt("again");
  await agent.setModel({ ...model, id: "other", contextWindow: 32000 });
  assert.equal(agent.contextInfo().tokenSource, "estimate");
  assert.equal(agent.contextInfo().budgetTokens, 32000 - 2048);
});

test("invalid reload budgets are rejected before saving or replacing the environment", async () => {
  let saves = 0;
  const agent = new Agent({ model, systemPrompt: "system", save: async () => { saves++; }, tools: builtinTools });
  const before = agent.contextInfo();
  await assert.rejects(agent.setEnvironment("new", builtinTools, undefined,
    { ...CONTEXT_LIMITS, reserveTokens: 128000 }, 3), /contextWindow 太小/);
  assert.equal(saves, 0);
  assert.deepEqual(agent.contextInfo(), before);
});

test("model and prompt updates commit together only after a successful save", async t => {
  let fail = true;
  let saved: SessionSnapshot | undefined;
  const agent = new Agent({
    model, systemPrompt: "old prompt", tools: builtinTools,
    save: async state => {
      if (fail) throw new Error("save-failed");
      saved = state;
    },
  });
  const next = { ...model, id: "other" };
  await assert.rejects(agent.setModel(next, undefined, "new prompt"), /save-failed/);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "mock");
    assert.equal(body.system, "old prompt");
    return response(text("done").content);
  });
  fail = false;
  await agent.prompt("question");
  await agent.setModel(next, undefined, "new prompt");
  assert.equal(saved!.model!.id, "other");
  assert.equal(saved!.messages[0]!.content, "new prompt");
  assert.equal(saved!.messages[1]!.content, "question");
});
