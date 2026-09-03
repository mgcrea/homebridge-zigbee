/**
 * What discovery puts on the radio, and what it does to the Home app.
 *
 * The platform is where a mistake is most expensive, because two of the things
 * it does are not undoable from the user's side. Unregistering an accessory
 * loses the room and scene assignments someone made by hand. And every request
 * it issues goes onto an adapter that runs one transaction at a time, so a pass
 * that reads more than it needs to is a pass the whole house waits behind.
 *
 * The supervisor is replaced here: these specs are about the pass, not about
 * opening a serial port.
 */
import type { API, PlatformAccessory, PlatformConfig } from "homebridge";
import type { Controller } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZigbeePlatform } from "#platform";

import {
  createFakeLog,
  FakeAccessory,
  FakeAdaptiveLightingController,
  FakeEndpoint,
  FakeHapStatusError,
  type FakeLog,
  nameProxy,
} from "./fake-hap";

import type * as controllerModule from "#zigbee/controller";

type ControllerModule = typeof controllerModule;

type Ready = (controller: Controller, result: "resumed" | "reset" | "restored") => Promise<void>;

const supervisors = vi.hoisted(() => ({ onReady: undefined as Ready | undefined }));

vi.mock("#zigbee/controller", async (importOriginal) => {
  const actual = await importOriginal<ControllerModule>();
  return {
    ...actual,
    ControllerSupervisor: class {
      constructor(_config: unknown, _paths: unknown, _log: unknown, onReady: Ready) {
        supervisors.onReady = onReady;
      }
      async start(): Promise<void> {
        await Promise.resolve();
      }
      async stop(): Promise<void> {
        await Promise.resolve();
      }
    },
  };
});

/** A read that can be interrupted, for the abandoned-pass cases. */
class HookedEndpoint extends FakeEndpoint {
  hook: (() => void) | undefined;

  override async read(cluster: string, attributes: string[]): Promise<Record<string, unknown>> {
    this.hook?.();
    return await super.read(cluster, attributes);
  }
}

class FakeDevice {
  constructor(
    readonly ieeeAddr: string,
    readonly endpoints: FakeEndpoint[],
    readonly options: {
      type?: string;
      powerSource?: string;
      interviewState?: string;
    } = {},
  ) {}

  get type(): string {
    return this.options.type ?? "Router";
  }
  get powerSource(): string {
    return this.options.powerSource ?? "Mains (single phase)";
  }
  get interviewState(): string {
    return this.options.interviewState ?? "SUCCESSFUL";
  }
  get manufacturerName(): string {
    return "Signify Netherlands B.V.";
  }
  get modelID(): string {
    return "LCT015";
  }
  get softwareBuildID(): string {
    return "1.0";
  }
  getEndpoint(id: number): FakeEndpoint | undefined {
    return this.endpoints.find((endpoint) => endpoint.ID === id);
  }
}

class FakeController {
  readonly #listeners = new Map<string, ((payload: never) => void)[]>();
  readonly coordinator = new FakeDevice("0x0000000000000001", [new FakeEndpoint(1)], {
    type: "Coordinator",
  });

  constructor(readonly devices: FakeDevice[] = []) {}

  on(event: string, listener: (payload: never) => void): this {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload as never);
  }

  *getDevicesIterator(predicate: (device: FakeDevice) => boolean): Generator<FakeDevice> {
    for (const device of [this.coordinator, ...this.devices]) {
      if (predicate(device)) yield device;
    }
  }

  getDevicesByType(type: string): FakeDevice[] {
    return type === "Coordinator" ? [this.coordinator] : this.devices;
  }

  getPermitJoin(): boolean {
    return false;
  }
}

class FakePlatformAccessory extends FakeAccessory {
  constructor(name: string, uuid: string) {
    super(uuid);
    this.displayName = name;
  }
}

type FakeApi = {
  api: API;
  fire: (event: string) => void;
  registered: PlatformAccessory[];
  unregistered: PlatformAccessory[];
  updated: PlatformAccessory[];
};

const createFakeApi = (): FakeApi => {
  const handlers = new Map<string, () => void>();
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  const updated: PlatformAccessory[] = [];

  const api = {
    hap: {
      Service: nameProxy,
      Characteristic: nameProxy,
      HapStatusError: FakeHapStatusError,
      AdaptiveLightingController: FakeAdaptiveLightingController,
      ColorUtils: {
        colorTemperatureToHueAndSaturation: (mired: number) => ({
          hue: Math.round(mired / 10),
          saturation: 42,
        }),
      },
      uuid: { generate: (seed: string) => `uuid:${seed}` },
    },
    platformAccessory: FakePlatformAccessory,
    user: { persistPath: () => "/tmp/homebridge-zigbee-spec" },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    registerPlatformAccessories: (_p: string, _n: string, list: PlatformAccessory[]) => {
      registered.push(...list);
    },
    unregisterPlatformAccessories: (_p: string, _n: string, list: PlatformAccessory[]) => {
      unregistered.push(...list);
    },
    updatePlatformAccessories: (list: PlatformAccessory[]) => {
      updated.push(...list);
    },
  } as unknown as API;

  return {
    api,
    fire: (event: string) => handlers.get(event)?.(),
    registered,
    unregistered,
    updated,
  };
};

const config = (extra: Record<string, unknown> = {}): PlatformConfig =>
  ({
    platform: "Zigbee",
    port: "/dev/serial/by-id/usb-spec",
    exposePairingSwitch: false,
    ...extra,
  }) as PlatformConfig;

let log: FakeLog;
let fakeApi: FakeApi;

/** Let the discovery pass, which is a chain of microtasks, run to completion. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

const launch = async (
  controller: FakeController,
  extra: Record<string, unknown> = {},
): Promise<ZigbeePlatform> => {
  const platform = new ZigbeePlatform(log as never, config(extra), fakeApi.api);
  fakeApi.fire("didFinishLaunching");
  await settle();

  await supervisors.onReady?.(controller as unknown as Controller, "resumed");
  await settle();
  return platform;
};

beforeEach(() => {
  log = createFakeLog();
  fakeApi = createFakeApi();
  supervisors.onReady = undefined;
});

describe("discovery", () => {
  it("adopts a mains-powered light and arranges its reporting", async () => {
    const endpoint = new FakeEndpoint();
    await launch(new FakeController([new FakeDevice("0x00178801020304", [endpoint])]));

    expect(fakeApi.registered).toHaveLength(1);
    expect(endpoint.binds).toContain("genOnOff");
    expect(endpoint.reportings.length).toBeGreaterThan(0);
  });

  it("neither binds nor polls a battery device", async () => {
    // It is asleep almost all of the time, so binding and reading it fails and
    // costs battery on the way. The reporting module has always said so; only
    // the periodic refresh used to honour it. The one-off description probe is
    // the exception, and it is cached, so it happens once per device ever.
    const endpoint = new FakeEndpoint();
    await launch(
      new FakeController([
        new FakeDevice("0x00158d0001020304", [endpoint], {
          type: "EndDevice",
          powerSource: "Battery",
        }),
      ]),
    );

    expect(fakeApi.registered).toHaveLength(1);
    expect(endpoint.binds).toHaveLength(0);
    expect(endpoint.reportings).toHaveLength(0);
    expect(endpoint.reads.map((read) => read.cluster)).not.toContain("genOnOff");
  });

  it("leaves a device that has not finished its interview for the next pass", async () => {
    // Its endpoints and clusters are whatever the interview has collected so
    // far, so anything read against them is a round trip spent on an answer
    // that is about to change.
    const endpoint = new FakeEndpoint();
    await launch(
      new FakeController([
        new FakeDevice("0x00178801020305", [endpoint], { interviewState: "PENDING" }),
      ]),
    );

    expect(fakeApi.registered).toHaveLength(0);
    expect(endpoint.reads).toHaveLength(0);
  });

  it("does not probe an endpoint whose description it already has", async () => {
    // The probe is the only part of a description that costs radio. Before
    // this, every reconnect re-read two descriptions per endpoint on top of
    // re-arming, and a restart re-read them all over again.
    const endpoint = new FakeEndpoint();
    const controller = new FakeController([new FakeDevice("0x00178801020304", [endpoint])]);
    await launch(controller);

    const readsAfterFirstPass = endpoint.reads.length;
    endpoint.reads.length = 0;

    // A reconnect: same devices, fresh controller objects.
    await supervisors.onReady?.(controller as unknown as Controller, "resumed");
    await settle();

    expect(readsAfterFirstPass).toBeGreaterThan(0);
    const clusters = endpoint.reads.map((read) => read.cluster);
    expect(clusters).not.toContain("genBasic");
  });
});

describe("a pass interrupted halfway", () => {
  it("does not unregister the accessories it never reached", async () => {
    // `#removeStale` used to run on a half-filled `seen` set, taking every
    // accessory the pass had not got to yet — and with them the rooms and
    // scenes the user had assigned by hand, permanently.
    const first = new HookedEndpoint(1, "0x00178801020301");
    const second = new FakeEndpoint(1, "0x00178801020302");
    const controller = new FakeController([
      new FakeDevice("0x00178801020301", [first]),
      new FakeDevice("0x00178801020302", [second]),
    ]);

    const platform = new ZigbeePlatform(log as never, config(), fakeApi.api);
    fakeApi.fire("didFinishLaunching");
    await settle();

    first.hook = () => {
      first.hook = undefined;
      fakeApi.fire("shutdown");
    };

    await supervisors.onReady?.(controller as unknown as Controller, "resumed");
    await settle();

    expect(platform).toBeInstanceOf(ZigbeePlatform);
    expect(fakeApi.unregistered).toHaveLength(0);
  });

  it("stops issuing requests once the controller underneath it has been replaced", async () => {
    const first = new HookedEndpoint(1, "0x00178801020301");
    const second = new FakeEndpoint(1, "0x00178801020302");
    const controller = new FakeController([
      new FakeDevice("0x00178801020301", [first]),
      new FakeDevice("0x00178801020302", [second]),
    ]);

    const platform = new ZigbeePlatform(log as never, config(), fakeApi.api);
    fakeApi.fire("didFinishLaunching");
    await settle();

    first.hook = () => {
      first.hook = undefined;
      // A reconnect mid-pass. Every remaining request in this pass is aimed at
      // a herdsman whose device cache has since been rebuilt.
      void supervisors.onReady?.(new FakeController() as unknown as Controller, "resumed");
    };

    await supervisors.onReady?.(controller as unknown as Controller, "resumed");
    await settle();

    expect(platform.controller).toBeDefined();
    expect(second.reads).toHaveLength(0);
    expect(fakeApi.unregistered).toHaveLength(0);
  });
});

describe("a device that announces itself several times", () => {
  it("is re-armed once, not once per announce", async () => {
    // Hue bulbs announce several times on power-up, and each announce used to
    // start its own unserialised pass of five binds and a full refresh against
    // an adapter that takes one request at a time.
    const endpoint = new FakeEndpoint();
    const device = new FakeDevice("0x00178801020304", [endpoint]);
    const controller = new FakeController([device]);
    await launch(controller);

    endpoint.binds.length = 0;
    const perPass = endpoint.reportings.length;
    endpoint.reportings.length = 0;

    controller.emit("deviceAnnounce", { device });
    controller.emit("deviceAnnounce", { device });
    controller.emit("deviceAnnounce", { device });
    await settle();

    expect(endpoint.reportings).toHaveLength(perPass);
  });

  it("does not re-arm a battery device, which has no power cycle to lose it to", async () => {
    const endpoint = new FakeEndpoint();
    const device = new FakeDevice("0x00158d0001020304", [endpoint], {
      type: "EndDevice",
      powerSource: "Battery",
    });
    const controller = new FakeController([device]);
    await launch(controller);

    controller.emit("deviceAnnounce", { device });
    await settle();

    expect(endpoint.binds).toHaveLength(0);
  });
});

describe("removing a device that has left", () => {
  it("forgets its stored values along with the accessory", async () => {
    const endpoint = new FakeEndpoint();
    endpoint.values = { genOnOff: { onOff: true } };
    const device = new FakeDevice("0x00178801020304", [endpoint]);
    const controller = new FakeController([device]);
    const platform = await launch(controller);

    // Stand in for the readResponse herdsman would route into the store.
    platform.state.apply("0x00178801020304/1", "genOnOff", { onOff: true });
    expect(platform.state.isKnown("0x00178801020304/1")).toBe(true);

    // It left the network; the next pass finds nothing.
    controller.devices.length = 0;
    await supervisors.onReady?.(controller as unknown as Controller, "resumed");
    await settle();

    expect(fakeApi.unregistered).toHaveLength(1);
    // Otherwise a device paired into the same slot later starts from another
    // device's last known state.
    expect(platform.state.isKnown("0x00178801020304/1")).toBe(false);
  });
});
