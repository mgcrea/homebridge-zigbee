import { beforeEach, describe, expect, it, vi } from "vitest";

import { COALESCE_WINDOW_MS, DeviceQueue, MIN_COMMAND_INTERVAL_MS } from "#model/queue";

beforeEach(() => {
  vi.useFakeTimers();
});

describe("DeviceQueue", () => {
  it("runs tasks one at a time, in order", async () => {
    const queue = new DeviceQueue();
    const order: number[] = [];

    const slow = async (id: number, ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(id);
    };

    const all = Promise.all([
      queue.run(async () => await slow(1, 30)),
      queue.run(async () => await slow(2, 5)),
      queue.run(async () => await slow(3, 1)),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await all;

    // Zigbee end devices drop overlapping requests, so ordering is the point.
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps running after a task rejects", async () => {
    const queue = new DeviceQueue();
    const after = vi.fn<() => void>();

    const failed = queue.run(async () => {
      await Promise.resolve();
      throw new Error("device did not respond");
    });
    await expect(failed).rejects.toThrow("device did not respond");

    // One failed write must not wedge every later command for this device.
    await queue.run(async () => {
      after();
      await Promise.resolve();
    });
    expect(after).toHaveBeenCalled();
  });

  it("keeps only the newest task under a key", async () => {
    const queue = new DeviceQueue();
    const ran: number[] = [];

    for (const value of [1, 2, 3]) {
      queue.coalesce("apply", async () => {
        ran.push(value);
        await Promise.resolve();
      });
    }

    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
    expect(ran).toEqual([3]);
  });

  it("keeps different keys independent", async () => {
    const queue = new DeviceQueue();
    const ran: string[] = [];

    queue.coalesce("a", async () => {
      ran.push("a");
      await Promise.resolve();
    });
    queue.coalesce("b", async () => {
      ran.push("b");
      await Promise.resolve();
    });

    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
    expect(ran.toSorted()).toEqual(["a", "b"]);
  });

  it("drops pending work on disposal", async () => {
    const queue = new DeviceQueue();
    const ran = vi.fn<() => void>();

    queue.coalesce("apply", async () => {
      ran();
      await Promise.resolve();
    });
    queue.dispose();

    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("throttling a stream of writes", () => {
  /**
   * Dragging the colour wheel emits writes for as long as the finger moves.
   * The coalescing window bounds a burst but not a stream, and an unthrottled
   * stream wedged a real OT-RCP coordinator.
   */
  it("paces a continuous drag instead of flooding the radio", async () => {
    const queue = new DeviceQueue();
    const sent: number[] = [];

    // Two seconds of dragging, a write every 20ms — 100 writes.
    for (let i = 0; i < 100; i += 1) {
      queue.coalesce("apply", async () => {
        sent.push(i);
        await Promise.resolve();
      });
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(MIN_COMMAND_INTERVAL_MS * 2);

    // 2s at 4/s is ~8, not 100. Generous bound: the point is the order of
    // magnitude, not an exact count.
    expect(sent.length).toBeLessThanOrEqual(15);
    expect(sent.length).toBeGreaterThan(0);
  });

  it("always sends the newest value last, however hard it throttled", async () => {
    const queue = new DeviceQueue();
    const sent: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      queue.coalesce("apply", async () => {
        sent.push(i);
        await Promise.resolve();
      });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(MIN_COMMAND_INTERVAL_MS * 2);

    // Throttling may drop intermediate values — a slider's are already stale —
    // but the light must end up where the user left it.
    expect(sent.at(-1)).toBe(19);
  });

  it("still answers a single write promptly", async () => {
    const queue = new DeviceQueue();
    const sent: string[] = [];

    queue.coalesce("apply", async () => {
      sent.push("on");
      await Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);

    // A lone tap must not wait out the throttle interval.
    expect(sent).toEqual(["on"]);
  });
});
