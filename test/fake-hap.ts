/**
 * A thin fake HAP.
 *
 * The accessory layer is the one part of a Homebridge plugin that never runs
 * outside a real bridge, and it is where a plugin ends up showing a fabricated
 * value for a device it has not heard from. The fake records characteristic
 * values and handlers, which is all that is needed to assert what HomeKit would
 * actually display, and deliberately models nothing else.
 */
import { vi } from "vitest";

import { StateStore } from "#model/state";
import type { ZigbeePlatform } from "#platform";

export class FakeCharacteristic {
  value: unknown = null;
  props: Record<string, unknown> = {};
  getHandler: (() => unknown) | undefined;
  setHandler: ((value: unknown) => unknown) | undefined;

  constructor(readonly name: string) {}

  onGet(handler: () => unknown): this {
    this.getHandler = handler;
    return this;
  }
  onSet(handler: (value: unknown) => unknown): this {
    this.setHandler = handler;
    return this;
  }
  updateValue(value: unknown): this {
    this.value = value;
    return this;
  }
  setProps(props: Record<string, unknown>): this {
    this.props = { ...this.props, ...props };
    return this;
  }
}

export class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();

  constructor(
    readonly type: string,
    readonly displayName: string,
    readonly subtype?: string,
  ) {}

  getCharacteristic(name: string): FakeCharacteristic {
    let characteristic = this.characteristics.get(name);
    if (!characteristic) {
      characteristic = new FakeCharacteristic(name);
      this.characteristics.set(name, characteristic);
    }
    return characteristic;
  }
  updateCharacteristic(name: string, value: unknown): this {
    this.getCharacteristic(name).updateValue(value);
    return this;
  }
  setCharacteristic(name: string, value: unknown): this {
    return this.updateCharacteristic(name, value);
  }
  /** What HomeKit would show: the get handler if there is one, else the cache. */
  read(name: string): unknown {
    const characteristic = this.getCharacteristic(name);
    return characteristic.getHandler ? characteristic.getHandler() : characteristic.value;
  }
  /** Drive a write the way HomeKit would. */
  write(name: string, value: unknown): unknown {
    return this.getCharacteristic(name).setHandler?.(value);
  }
}

/** Records that a controller was configured, which is all the specs need to see. */
export class FakeAdaptiveLightingController {
  constructor(
    readonly service: unknown,
    readonly options: Record<string, unknown>,
  ) {}
}

export class FakeAccessory {
  readonly services: FakeService[] = [];
  readonly context: Record<string, unknown> = {};
  readonly controllers: unknown[] = [];
  displayName = "";

  constructor(public UUID = "uuid-1") {}

  configureController(controller: unknown): void {
    this.controllers.push(controller);
  }

  getService(type: string): FakeService | undefined {
    return this.services.find((service) => service.type === type && !service.subtype);
  }
  getServiceById(type: string, subtype: string): FakeService | undefined {
    return this.services.find((service) => service.type === type && service.subtype === subtype);
  }
  addService(type: string, displayName: string, subtype?: string): FakeService {
    const service = new FakeService(type, displayName, subtype);
    this.services.push(service);
    return service;
  }
  removeService(service: FakeService): void {
    const index = this.services.indexOf(service);
    if (index >= 0) this.services.splice(index, 1);
  }
}

/** Service and characteristic names are their own identity in the fake. */
export const nameProxy = new Proxy({} as Record<string, string>, {
  get: (_target, property) => String(property),
});

export class FakeHapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HAP ${hapStatus}`);
  }
}

export type FakeLog = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

export const createFakeLog = (): FakeLog => ({
  info: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
  debug: vi.fn<(message: string) => void>(),
});

/**
 * A stand-in endpoint that records the commands an accessory sends.
 *
 * This is what the coalescing assertions read: the point of the queue is that
 * four HomeKit writes become one radio command, and the only way to see that is
 * to count what arrived here.
 */
export class FakeEndpoint {
  readonly commands: { cluster: string; command: string; payload: Record<string, unknown> }[] = [];
  readonly reads: { cluster: string; attributes: string[] }[] = [];
  readonly ID = 1;
  readonly deviceIeeeAddress = "0x00178801020304";
  failNext = false;

  async command(
    cluster: string,
    command: string,
    payload: Record<string, unknown>,
  ): Promise<undefined> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("device did not respond");
    }
    this.commands.push({ cluster, command, payload });
    return await Promise.resolve(undefined);
  }

  async read(cluster: string, attributes: string[]): Promise<Record<string, unknown>> {
    this.reads.push({ cluster, attributes });
    return await Promise.resolve({});
  }

  supportsInputCluster(): boolean {
    return true;
  }
  getInputClusters(): unknown[] {
    return [];
  }
}

export const createFakePlatform = (
  overrides: {
    log?: FakeLog;
    state?: StateStore;
    config?: Record<string, unknown>;
  } = {},
): ZigbeePlatform & { log: FakeLog; state: StateStore } =>
  ({
    Service: nameProxy,
    Characteristic: nameProxy,
    api: {
      hap: {
        HapStatusError: FakeHapStatusError,
        AdaptiveLightingController: FakeAdaptiveLightingController,
        // Real hap-nodejs maths would only make the assertions harder to read;
        // the specs care that the mirroring happens, not what warm white is.
        ColorUtils: {
          colorTemperatureToHueAndSaturation: (mired: number) => ({
            hue: Math.round(mired / 10),
            saturation: 42,
          }),
        },
      },
    },
    log: overrides.log ?? createFakeLog(),
    state: overrides.state ?? new StateStore(),
    controller: undefined,
    config: {
      name: "Zigbee",
      port: "/dev/ttyACM0",
      adapter: "zoh",
      baudRate: 460_800,
      rtscts: true,
      channel: 15,
      exposePairingSwitch: true,
      permitJoinDuration: 120,
      refreshInterval: 300,
      transitionTime: 0.4,
      adaptiveLighting: true,
      allowNetworkReset: false,
      debug: false,
      devices: [],
      ...overrides.config,
    },
  }) as unknown as ZigbeePlatform & { log: FakeLog; state: StateStore };
