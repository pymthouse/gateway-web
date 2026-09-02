const PUT_TIMEOUT_MS = 5_000;

export class QueueTimeoutError extends Error {
  constructor(message = `Trickle segment writer timed out after ${PUT_TIMEOUT_MS / 1000}s`) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

/**
 * Bounded async queue (maxsize 1) used as the trickle POST body.
 * `null` is the end-of-stream sentinel.
 */
export class ByteQueue {
  consumed = false;
  private readonly items: Array<Uint8Array | null> = [];
  private waiters: Array<() => void> = [];

  async push(data: Uint8Array, timeoutMs = PUT_TIMEOUT_MS): Promise<void> {
    await this.put(data, timeoutMs);
  }

  async close(timeoutMs = PUT_TIMEOUT_MS): Promise<void> {
    try {
      await this.put(null, timeoutMs);
    } catch {
      // close is best-effort
    }
  }

  async *iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const item = await this.take();
      if (item === null) return;
      this.consumed = true;
      yield item;
    }
  }

  private async put(item: Uint8Array | null, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.items.length >= 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueueTimeoutError();
      await this.wait(remaining);
    }
    this.items.push(item);
    this.wake();
  }

  private async take(): Promise<Uint8Array | null> {
    while (this.items.length === 0) {
      await this.wait();
    }
    const item = this.items.shift() ?? null;
    this.wake();
    return item;
  }

  private wait(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onReady);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.waiters = this.waiters.filter((w) => w !== onReady);
              reject(new QueueTimeoutError());
            }, timeoutMs);
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
