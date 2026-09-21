import { RequestTimeoutError } from "./control.js";
import { readMessageStream } from "./stream.js";
import { estimateInputTokens, fitOutputBudget } from "./budget.js";
import {
  messagesUrl,
  reasoningParameters,
  replayMessages,
  requestHeaders,
} from "./model.js";


import type {
  LLMResponse,
  Message,
  ModelConfig,
  StreamEvent,
  ToolDefinition,
} from "./types.js";

export async function callLLM(
  config: ModelConfig,
  messages: Message[],
  tools: ToolDefinition[] = [],
  onEvent?: (event: StreamEvent) => void,
  signal?: AbortSignal,
  inputTokens?: number,
): Promise<LLMResponse> {
  signal?.throwIfAborted();
  config = fitOutputBudget(config, inputTokens ?? estimateInputTokens(config, messages, tools).tokens);

  const totalMs = config.requestTimeoutMs ?? 300_000;
  const idleMs = config.idleTimeoutMs ?? 60_000;

  for (const ms of [totalMs, idleMs]) {
    if (!Number.isInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
      throw new Error("超时必须是 1～2147483647 之间的整数毫秒数");
    }
  }

  // 用户取消和请求超时，都汇入这个请求自己的 controller。
  const controller = new AbortController();

  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });

  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const touch = () => {
    clearTimeout(idleTimer);

    if (!controller.signal.aborted) {
      idleTimer = setTimeout(
        () => controller.abort(
          new RequestTimeoutError("idle", idleMs),
        ),
        idleMs,
      );
    }
  };

  const totalTimer = setTimeout(
    () => controller.abort(
      new RequestTimeoutError("total", totalMs),
    ),
    totalMs,
  );

  try {
    // 等待响应头也计入空闲时间。
    touch();

    const response = await fetch(
      messagesUrl(config.baseUrl),
      {
        method: "POST",
        signal: controller.signal,
        headers: requestHeaders(config),

        body: JSON.stringify({
          model: config.id,

          system: messages
            .filter(m => m.role === "system")
            .map(m => m.content)
            .join("\n\n"),

          messages: replayMessages(messages)
            .filter(m => m.role !== "system"),

          max_tokens: config.maxTokens,
          tools,
          ...reasoningParameters(config),
          stream: true,
        }),
      },
    );

    controller.signal.throwIfAborted();
    touch();

    if (!response.ok) {
      throw new Error(
        `LLM request failed: ${response.status}\n${await response.text()}`,
      );
    }

    if (!response.body) {
      throw new Error("模型响应没有可读的流");
    }

    if (
      !response.headers
        .get("content-type")
        ?.includes("text/event-stream")
    ) {
      throw new Error("服务端没有返回 SSE，请检查网关的流式支持");
    }

    // 按网络数据刷新计时，包括 SSE 心跳。
    // 不依赖模型是否输出了可见文本。
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          controller.signal.throwIfAborted();

          if (chunk.byteLength > 0) touch();

          stream.enqueue(chunk);
        },
      }),
      { signal: controller.signal },
    );

    const result = await readMessageStream(body, (event) => {
      controller.signal.throwIfAborted();
      onEvent?.(event);
    });

    controller.signal.throwIfAborted();

    return result;
  } catch (error) {
    // 保留取消或超时的具体原因。
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);

    signal?.removeEventListener("abort", forwardAbort);

    // 释放可能尚未关闭的请求。
    controller.abort();
  }
}
