import type {
  AssistantMessage,
  LLMResponse,
  StreamEvent,
} from "./types.js";

type Block = AssistantMessage["content"][number];
type Listener = (event: StreamEvent) => void;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("流事件中出现无效对象");
  }

  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("流事件中出现无效字符串");
  }

  return value;
}

function parseBlock(value: unknown): Block {
  const block = object(value);

  switch (block.type) {
    case "text":
      string(block.text);
      break;

    case "thinking":
      string(block.thinking);
      if (block.signature !== undefined) {
        string(block.signature);
      }
      break;

    case "redacted_thinking":
      string(block.data);
      break;

    case "tool_use":
      if (!string(block.id) || !string(block.name)) {
        throw new Error("工具调用缺少 id 或 name");
      }
      object(block.input);
      break;

    default:
      throw new Error(`不支持的内容块：${block.type}`);
  }

  return value as Block;
}

// 网络 chunk 不等于 SSE 事件。
// 按空行分隔事件，并支持一个事件包含多行 data。
async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let data: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();

      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });

      while (true) {
        const end = buffer.search(/[\r\n]/);

        if (end < 0) break;

        // 等待下一个 chunk，判断是否为跨 chunk 的 CRLF。
        if (
          buffer[end] === "\r" &&
          end === buffer.length - 1 &&
          !done
        ) {
          break;
        }

        const line = buffer.slice(0, end);
        const size = buffer.startsWith("\r\n", end) ? 2 : 1;

        buffer = buffer.slice(end + size);

        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n");
            data = [];

            yield object(JSON.parse(payload));
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }

      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: Listener,
): Promise<LLMResponse> {
  const content: Block[] = [];
  const toolIds = new Set<string>();

  let started = false;
  let stopReason: string | null = null;

  let current:
    | {
        index: number;
        block: Block;
        json: string;
      }
    | undefined;

  const emitDelta = (
    kind: "text" | "thinking",
    text: string,
  ) => {
    if (text) {
      onEvent?.({ type: "delta", kind, text });
    }
  };

  for await (const event of readSSE(body)) {
    if (event.type === "ping") continue;

    if (event.type === "error") {
      throw new Error(
        `模型流错误：${string(object(event.error).message)}`,
      );
    }

    if (event.type === "message_start") {
      const message = object(event.message);

      if (
        started ||
        message.role !== "assistant" ||
        !Array.isArray(message.content) ||
        message.content.length !== 0
      ) {
        throw new Error("无效的 message_start");
      }

      started = true;
      continue;
    }

    if (!started) {
      throw new Error("缺少 message_start");
    }

    if (event.type === "content_block_start") {
      if (
        current ||
        stopReason !== null ||
        event.index !== content.length
      ) {
        throw new Error("内容块顺序错误");
      }

      const block = parseBlock(event.content_block);

      current = {
        index: content.length,
        block,
        json: "",
      };

      if (block.type === "text" || block.type === "thinking") {
        onEvent?.({ type: "start", kind: block.type });

        emitDelta(
          block.type,
          block.type === "text" ? block.text : block.thinking,
        );
      } else if (block.type === "redacted_thinking") {
        onEvent?.({ type: "start", kind: "thinking" });
        emitDelta(
          "thinking",
          "[服务端返回了不可显示的 thinking 块]",
        );
      }

      continue;
    }

    if (event.type === "content_block_delta") {
      if (!current || event.index !== current.index) {
        throw new Error("增量没有对应的内容块");
      }

      const delta = object(event.delta);
      const block = current.block;

      if (delta.type === "text_delta" && block.type === "text") {
        const text = string(delta.text);

        block.text += text;
        emitDelta("text", text);
      } else if (
        delta.type === "thinking_delta" &&
        block.type === "thinking"
      ) {
        const text = string(delta.thinking);

        block.thinking += text;
        emitDelta("thinking", text);
      } else if (
        delta.type === "signature_delta" &&
        block.type === "thinking"
      ) {
        block.signature =
          (block.signature ?? "") + string(delta.signature);
      } else if (
        delta.type === "input_json_delta" &&
        block.type === "tool_use"
      ) {
        current.json += string(delta.partial_json);
      } else {
        throw new Error(
          `不支持或不匹配的增量：${delta.type}`,
        );
      }

      continue;
    }

    if (event.type === "content_block_stop") {
      if (!current || event.index !== current.index) {
        throw new Error("内容块结束顺序错误");
      }

      const block = current.block;

      if (block.type === "tool_use") {
        // 参数完整后才解析。
        if (current.json) {
          block.input = object(JSON.parse(current.json));
        }

        if (toolIds.has(block.id)) {
          throw new Error("工具调用 id 重复");
        }

        toolIds.add(block.id);
      } else {
        onEvent?.({
          type: "end",
          kind: block.type === "text" ? "text" : "thinking",
        });
      }

      content.push(block);
      current = undefined;

      continue;
    }

    if (event.type === "message_delta") {
      if (current) {
        throw new Error("消息结束时仍有未完成的内容块");
      }

      const reason = object(event.delta).stop_reason;

      if (reason !== null && reason !== undefined) {
        stopReason = string(reason);
      }

      continue;
    }

    if (event.type === "message_stop") {
      if (current || !stopReason) {
        throw new Error("模型消息不完整");
      }

      return {
        message: {
          role: "assistant",
          content,
        },
        stopReason,
      };
    }

    // 忽略未知的顶层通知。
    // 未知内容块或增量已在上面明确报错。
  }

  throw new Error(
    "连接提前结束：未收到 message_stop，本轮未完成",
  );
}