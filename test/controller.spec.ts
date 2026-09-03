/**
 * The reset guard, the port release, and the supervisor's retry contract.
 *
 * `start()` reporting "reset" is completely normal on a first run and a
 * catastrophe on any later one: it means the adapter formed a new network while
 * devices were still paired to the old one. Getting this wrong shows up as
 * every light in the house going unresponsive at once, so it is worth pinning
 * down precisely — including the part that has to happen *before* the radio is
 * opened, because by the time `start()` answers, herdsman has already emptied
 * the database.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logging } from "homebridge";
import type { Controller } from "zigbee-herdsman";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertNetworkIntact,
  assertSafeToStart,
  closeController,
  type ControllerPaths,
  ControllerSupervisor,
  countPairedDevices,
  NetworkResetError,
  type openController,
  resolvePaths,
  type StartOutcome,
} from "#zigbee/controller";
import type { ZigbeeConfig } from "#config";

const config = (overrides: Partial<ZigbeeConfig> = {}): ZigbeeConfig =>
  ({ adapter: "zoh", allowNetworkReset: false, port: "/dev/null", ...overrides }) as ZigbeeConfig;

const createLog = (): Logging =>
  ({
    info: vi.fn<(m: string) => void>(),
    warn: vi.fn<(m: string) => void>(),
    error: vi.fn<(m: string) => void>(),
    debug: vi.fn<(m: string) => void>(),
  }) as unknown as Logging;

let directory: string;
let paths: ControllerPaths;
let log: Logging;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zigbee-guard-"));
  paths = { stateDirectory: directory };
  log = createLog();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** herdsman's own format: one JSON object per line, devices and groups mixed. */
const writeDatabase = (name: string, types: readonly string[]): void => {
  writeFileSync(
    join(directory, name),
    `${types.map((type, index) => JSON.stringify({ id: index + 1, type })).join("\n")}\n`,
  );
};

const touch = (name: string): void => {
  writeFileSync(join(directory, name), "{}\n");
};

describe("countPairedDevices", () => {
  it("is zero when there is no database at all — a first run", () => {
    expect(countPairedDevices(join(directory, "devices.db"))).toBe(0);
  });

  it("does not count the coordinator, which is always there", () => {
    writeDatabase("devices.db", ["Coordinator"]);
    expect(countPairedDevices(join(directory, "devices.db"))).toBe(0);
  });

  it("counts routers and end devices, but not groups", () => {
    writeDatabase("devices.db", ["Coordinator", "Router", "EndDevice", "Group", "EndDevice"]);
    expect(countPairedDevices(join(directory, "devices.db"))).toBe(3);
  });

  it("skips a corrupted line rather than refusing to answer", () => {
    // Undercounting only ever makes the guard less likely to fire, which is the
    // safe direction for a file this function is not the owner of.
    writeFileSync(
      join(directory, "devices.db"),
      `${JSON.stringify({ id: 1, type: "Router" })}\nnot json at all\n\n`,
    );
    expect(countPairedDevices(join(directory, "devices.db"))).toBe(1);
  });
});

describe("the pre-flight guard", () => {
  it("lets a first run through: nothing is paired, so nothing can be orphaned", () => {
    expect(() => assertSafeToStart(config(), paths, 0, log)).not.toThrow();
  });

  it("lets a normal run through when zoh still has its saved network", () => {
    touch("zoh.save");
    expect(() => assertSafeToStart(config(), paths, 7, log)).not.toThrow();
  });

  it("refuses when zoh.save has gone and devices are still paired", () => {
    // zoh compares the configured identity against zoh.save to decide whether
    // to keep the network. With no save file it forms a new one, unconditionally.
    expect(() => assertSafeToStart(config(), paths, 7, log)).toThrow(NetworkResetError);
  });

  it("names the file, the count and the way out", () => {
    const attempt = (): void => {
      assertSafeToStart(config(), paths, 7, log);
    };

    expect(attempt).toThrow("zoh.save");
    expect(attempt).toThrow("7 device(s)");
    expect(attempt).toThrow("devices.db.backup");
    expect(attempt).toThrow("allowNetworkReset");
  });

  it("does not second-guess an adapter that is not zoh", () => {
    // Only zoh keeps its network state in a file beside ours; an ember stick
    // holds it in the NCP's own flash, where its absence proves nothing.
    expect(() => assertSafeToStart(config({ adapter: "ember" }), paths, 7, log)).not.toThrow();
  });

  it("goes on refusing after the first refusal, from the marker alone", () => {
    // The restart after a refusal looks healthy from every other angle: zoh.save
    // now matches, start() would answer "resumed", and devices.db is empty
    // because herdsman cleared it. Only the marker still knows.
    touch("zoh.save");
    touch("network-reset.json");
    expect(() => assertSafeToStart(config(), paths, 7, log)).toThrow(/already refused/);
  });

  it("stands down, and forgets the refusal, once the reset is asked for explicitly", () => {
    touch("network-reset.json");
    expect(() =>
      assertSafeToStart(config({ allowNetworkReset: true }), paths, 7, log),
    ).not.toThrow();
    // The marker has to go, or the next start with the opt-in removed would
    // refuse over a network the user deliberately rebuilt.
    expect(() => assertSafeToStart(config(), paths, 7, log)).toThrow(/zoh\.save/);
  });
});

const outcome = (
  result: StartOutcome["result"],
  previouslyPaired: number,
): Pick<StartOutcome, "result" | "previouslyPaired"> => ({ result, previouslyPaired });

describe("assertNetworkIntact", () => {
  it("allows a reset on a first run, when nothing was paired yet", () => {
    expect(() => assertNetworkIntact(outcome("reset", 0), config(), paths)).not.toThrow();
  });

  it("refuses a reset that orphaned paired devices", () => {
    expect(() => assertNetworkIntact(outcome("reset", 7), config(), paths)).toThrow(
      NetworkResetError,
    );
  });

  it("says how many devices were lost and how to get them back", () => {
    const attempt = (): void => {
      assertNetworkIntact(outcome("reset", 7), config(), paths);
    };

    expect(attempt).toThrow("7 device(s)");
    expect(attempt).toThrow(/restore/i);
    expect(attempt).toThrow("allowNetworkReset");
  });

  it("honours the explicit opt-in", () => {
    expect(() =>
      assertNetworkIntact(outcome("reset", 7), config({ allowNetworkReset: true }), paths),
    ).not.toThrow();
  });

  it("never blocks a normal resume or restore", () => {
    expect(() => assertNetworkIntact(outcome("resumed", 7), config(), paths)).not.toThrow();
    expect(() => assertNetworkIntact(outcome("restored", 7), config(), paths)).not.toThrow();
  });
});

describe("resolvePaths", () => {
  it("keeps all coordinator state under one directory on the persist volume", () => {
    // zoh writes zoh.save and zoh_config.json beside the backup path, so these
    // have to land somewhere that survives a container recreate.
    expect(resolvePaths("/homebridge/persist").stateDirectory).toBe("/homebridge/persist/zigbee");
  });
});

/**
 * Stands in for herdsman's `Controller`, modelling the two things that decide
 * whether the port is actually released.
 *
 * `stop()` runs an unguarded `backup()` before it reaches `adapter.stop()`, and
 * `backup()` throws on an adapter that never finished starting — so the port
 * was left open and every retry hit "Cannot lock port". `backup()` only touches
 * the adapter when `backupPath` is set, so clearing it lets `stop()` complete.
 *
 * And on zoh `adapter.stop()` stops the driver without closing the file
 * descriptor. Only `closePort()` releases it.
 */
class FakeController {
  stopped = false;
  portClosed = false;
  stopCalls = 0;
  options: { backupPath?: string | undefined } = { backupPath: "/state/backup.json" };
  adapter: { closePort: () => Promise<void> } | undefined = {
    closePort: async () => {
      this.portClosed = true;
      await Promise.resolve();
    },
  };
  #disconnected: boolean;

  constructor(disconnected = false) {
    this.#disconnected = disconnected;
  }

  isAdapterDisconnected(): boolean {
    return this.#disconnected;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await Promise.resolve();
    if (this.options.backupPath !== undefined) {
      throw new Error("backup failed: adapter not started");
    }
    this.stopped = true;
  }
}

const close = async (controller: FakeController, mode: Parameters<typeof closeController>[2]) => {
  await closeController(controller as unknown as Controller, log, mode);
};

describe("releasing the port", () => {
  it("reaches adapter.stop() after a failed start by defusing the unguarded backup", async () => {
    const controller = new FakeController();
    await close(controller, "failed-start");
    expect(controller.stopped).toBe(true);
    expect(controller.portClosed).toBe(true);
  });

  it("would NOT have released it without that step", async () => {
    const controller = new FakeController();
    await controller.stop().catch(() => undefined);
    expect(controller.stopped).toBe(false);
  });

  it("skips a stop() that cannot reach the adapter, and closes the port directly", async () => {
    // adapter.start() never succeeded, so stop() saves the database and returns
    // without ever touching the port. Calling it is pure delay.
    const controller = new FakeController(true);
    await close(controller, "failed-start");
    expect(controller.stopCalls).toBe(0);
    expect(controller.portClosed).toBe(true);
  });

  it("says nothing alarming when the adapter was never even created", async () => {
    const controller = new FakeController();
    controller.adapter = undefined;
    await close(controller, "failed-start");
    expect(controller.stopCalls).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("closes the port on shutdown, which adapter.stop() alone does not do on zoh", async () => {
    const controller = new FakeController();
    controller.options.backupPath = undefined;
    await close(controller, "shutdown");
    expect(controller.stopped).toBe(true);
    expect(controller.portClosed).toBe(true);
  });

  it("only warns about a restart when the port itself would not close", async () => {
    const controller = new FakeController();
    controller.options.backupPath = undefined;
    controller.adapter = {
      closePort: async () => {
        await Promise.resolve();
        throw new Error("EBUSY");
      },
    };

    await close(controller, "shutdown");
    expect(String(vi.mocked(log.error).mock.calls[0]?.[0])).toContain("restart Homebridge");
  });

  it("does not warn about a restart merely because stop() complained", async () => {
    // A stop() that throws is bookkeeping; the port is what matters, and it closed.
    const controller = new FakeController();
    await close(controller, "refused");
    expect(controller.portClosed).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });
});

/** A controller the supervisor can adopt: it only ever subscribes to one event. */
const openable = (): StartOutcome => {
  const controller = new FakeController();
  controller.options.backupPath = undefined;
  return {
    controller: Object.assign(controller, { on: () => controller }) as unknown as Controller,
    result: "resumed",
    previouslyPaired: 0,
  };
};

describe("the supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const supervisor = (
    open: () => Promise<StartOutcome>,
    onReady: () => Promise<void> = async () => await Promise.resolve(),
  ): ControllerSupervisor =>
    new ControllerSupervisor(config(), paths, log, onReady, open as typeof openController);

  /**
   * A USB coordinator is routinely unavailable for a moment — after a container
   * restart the previous process may not have released it, and a ZBT-2's USB
   * bridge needs a beat before it answers Spinel. Seen in the field as
   * `SPINEL[tid=1] Timeout after 10000ms`, which used to leave the plugin dead
   * until Homebridge itself was restarted.
   */
  it("keeps retrying after a transient failure to open", async () => {
    let attempts = 0;
    const open = vi.fn<() => Promise<StartOutcome>>(async () => {
      attempts += 1;
      await Promise.resolve();
      if (attempts < 3) throw new Error("SPINEL[tid=1] Timeout after 10000ms");
      return openable();
    });

    const ready = vi.fn<() => Promise<void>>(async () => await Promise.resolve());
    await supervisor(open, ready).start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(attempts).toBe(3);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a healthy coordinator because the platform threw", async () => {
    // `onReady` failing is a bug in the accessory layer, not evidence about the
    // radio. Treating it as one closed a working controller and reopened it in
    // a loop, with the backoff reset on every pass.
    const open = vi.fn<() => Promise<StartOutcome>>(async () => await Promise.resolve(openable()));
    const ready = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
      throw new Error("discovery blew up");
    });

    await supervisor(open, ready).start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(open).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(log.error).mock.calls[0]?.[0])).toContain("The radio is fine");
  });

  it("lets a deliberate refusal out of start(), rather than retrying it", async () => {
    const open = vi.fn<() => Promise<StartOutcome>>(async () => {
      await Promise.resolve();
      throw new NetworkResetError("refused");
    });

    await expect(supervisor(open).start()).rejects.toThrow(NetworkResetError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("stops the reconnect loop on a refusal instead of hammering the radio", async () => {
    let attempts = 0;
    const open = vi.fn<() => Promise<StartOutcome>>(async () => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) throw new Error("port busy");
      throw new NetworkResetError("the coordinator formed a NEW network");
    });

    await supervisor(open).start();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(attempts).toBe(2);
  });
});
