/**
 * Per-device command serialisation with a short coalescing window.
 *
 * Two facts about the two ends make this necessary.
 *
 * HomeKit never sends "set this light to red at 40%" as one message. Dragging
 * the colour wheel writes Hue and Saturation as two separate characteristic
 * sets, and activating a scene writes On, Brightness and ColorTemperature at
 * once. Sent straight through, that is three or four round trips to a bulb that
 * visibly steps through each one.
 *
 * Zigbee end devices, meanwhile, drop overlapping requests rather than queueing
 * them, so the commands that do go out have to go out one at a time.
 *
 * So: writes land in a pending record, a short timer coalesces whatever arrives
 * inside the window, and the flush runs commands strictly in sequence.
 */

/** Long enough to catch HomeKit's split writes, short enough to feel instant. */
export const COALESCE_WINDOW_MS = 50;

export type Task<T> = () => Promise<T>;

/**
 * A queue of work for one device.
 *
 * `run` serialises. `coalesce` additionally merges repeated calls under the
 * same key inside the window, keeping only the newest — the right behaviour for
 * a slider being dragged, where every intermediate value is already stale.
 */
export class DeviceQueue {
  #tail: Promise<unknown> = Promise.resolve();
  readonly #pending = new Map<string, { timer: NodeJS.Timeout; task: Task<unknown> }>();
  #disposed = false;

  constructor(private readonly window: number = COALESCE_WINDOW_MS) {}

  /** Run a task after everything already queued for this device. */
  async run<T>(task: Task<T>): Promise<T> {
    if (this.#disposed) throw new Error("Queue disposed");

    const result = this.#tail.then(task, task);
    // Keep the chain alive even when a command rejects, or one failed write
    // would wedge every later command for this device.
    this.#tail = result.catch(() => undefined);
    return await result;
  }

  /**
   * Schedule a task under `key`, replacing any task already waiting under it.
   *
   * Returns nothing: the caller has already told HomeKit the write succeeded,
   * and the radio result arrives later through the reporting path.
   */
  coalesce(key: string, task: Task<unknown>): void {
    if (this.#disposed) return;

    const existing = this.#pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.#pending.delete(key);
      void this.run(task).catch(() => undefined);
    }, this.window);
    timer.unref?.();

    this.#pending.set(key, { timer, task });
  }

  /** Send everything waiting immediately, without waiting out the window. */
  flush(): void {
    for (const [key, { timer, task }] of this.#pending) {
      clearTimeout(timer);
      this.#pending.delete(key);
      void this.run(task).catch(() => undefined);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
