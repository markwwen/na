export function argumentsOf(
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工具参数必须是对象");
  }

  return input as Record<string, unknown>;
}

export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string {
  if (typeof args[key] !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }

  return args[key];
}

