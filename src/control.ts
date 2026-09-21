export class TaskCancelledError extends Error {
  constructor() {
    super("已取消当前任务");
    this.name = "TaskCancelledError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(kind: "total" | "idle", ms: number) {
    super(
      kind === "total"
        ? `单次模型请求超过 ${ms / 1000} 秒`
        : `连续 ${ms / 1000} 秒未收到服务端数据`,
    );

    this.name = "RequestTimeoutError";
  }
}

// 停止等待操作；底层是否真正停止，取决于操作自身是否支持 signal。
export function abortable<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    // 同时接住同步异常，以及取消后才发生的异步异常。
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);

          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
  });
}