import { stdout as output } from "node:process";
import type { StreamEvent } from "../types.js";

export function createStreamPrinter() {
  const colored =
    output.isTTY &&
    process.env.TERM !== "dumb" &&
    process.env.NO_COLOR === undefined;

  const gray = colored
    ? "\x1b[48;5;236m\x1b[38;5;252m"
    : "";

  const reset = colored ? "\x1b[0m" : "";
  const fill = colored ? "\x1b[K" : "";

  let active: "text" | "thinking" | undefined;
  let opened = false;
  let pendingWhitespace = "";

  function finish(): void {
    if (opened) {
      if (active === "thinking") {
        output.write(`${gray}${fill}${reset}`);
      }

      output.write("\n");
    }

    active = undefined;
    opened = false;
    pendingWhitespace = "";
  }

  function onEvent(event: StreamEvent): void {
    if (event.type === "start") {
      finish();
      active = event.kind;
      return;
    }

    if (event.type === "end") {
      finish();
      return;
    }

    if (active !== event.kind) {
      throw new Error("显示事件缺少匹配的 start");
    }

    // 暂存尾部空白，等后续内容到来再决定是否显示。
    const combined =
      pendingWhitespace + event.text.replace(/\r/g, "");

    const visible = combined.trimEnd();
    pendingWhitespace = combined.slice(visible.length);

    if (!visible) return;

    // 真正有内容时才打开区域。
    // 空文本块不会产生额外间距。
    if (!opened) {
      opened = true;

      if (active === "thinking") {
        output.write(
          `\n${gray}  [thinking]${fill}${reset}\n  `,
        );
      } else {
        output.write("\n");
      }
    }

    if (active === "thinking") {
      const padded = visible.replace(
        /\n/g,
        `${fill}${reset}\n${gray}  `,
      );

      output.write(`${gray}${padded}${reset}`);
    } else {
      output.write(visible);
    }
  }

  return { onEvent, finish };
}