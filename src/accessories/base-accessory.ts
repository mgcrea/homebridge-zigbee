import type { PlatformAccessory } from "homebridge";
import type { Models } from "zigbee-herdsman";

import type { DeviceView } from "#model/device";
import { DeviceQueue } from "#model/queue";
import type { ZigbeePlatform } from "#platform";
import { refresh } from "#zigbee/reporting";

/** HAP refuses a SerialNumber longer than this, and drops the whole accessory. */
const MAX_SERIAL_LENGTH = 64;

/**
 * What every Zigbee accessory has in common.
 *
 * There is no deep hierarchy below this on purpose: the AccessoryInformation
 * block, the command queue, the "have we heard from it yet" guard and disposal
 * are genuinely shared, and everything else belongs to the specific device kind.
 */
export abstract class BaseAccessory {
  protected readonly queue: DeviceQueue;
  readonly #unsubscribes: (() => void)[] = [];
  #disposed = false;

  constructor(
    protected readonly platform: ZigbeePlatform,
    protected readonly accessory: PlatformAccessory,
    protected view: DeviceView,
    protected readonly endpoint: Models.Endpoint,
  ) {
    this.queue = new DeviceQueue();
  }

  get key(): string {
    return this.view.key;
  }

  get displayName(): string {
    return this.accessory.displayName || this.view.name;
  }

  /** Only mains-powered devices are polled; see `refreshFromRadio`. */
  get mainsPowered(): boolean {
    return this.view.mainsPowered;
  }

  /**
   * Re-read this device's attributes.
   *
   * Queued behind any commands already in flight, so a refresh cannot overtake
   * a write the user just made and briefly show them the old value back.
   */
  async refreshFromRadio(): Promise<void> {
    if (this.#disposed) return;
    await this.queue.run(async () => {
      await refresh(this.endpoint, this.platform.log);
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether the device has told us anything yet.
   *
   * Until it has, reads throw rather than reporting a plausible-looking value.
   * A light that shows "Off" because nothing has been read yet is worse than
   * one that shows "No Response": the first is a confident wrong answer, the
   * second is visibly an absence of one.
   */
  protected abstract get isReadable(): boolean;

  protected assertReadable(): void {
    if (!this.isReadable) {
      // -70402 is `HAPStatus.SERVICE_COMMUNICATION_FAILURE`. Spelled
      // numerically because the enum is an ambient const enum, which
      // `verbatimModuleSyntax` forbids reaching into at runtime.
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  protected configureInformation(): void {
    const { Service, Characteristic } = this.platform;
    const information =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);

    information
      .setCharacteristic(Characteristic.Manufacturer, this.view.manufacturer)
      .setCharacteristic(Characteristic.Model, this.view.model)
      .setCharacteristic(Characteristic.SerialNumber, usableSerial(this.view.ieee))
      .setCharacteristic(Characteristic.Name, this.displayName);

    if (this.view.firmware) {
      information.setCharacteristic(Characteristic.FirmwareRevision, this.view.firmware);
    }
  }

  /** Track a store subscription so disposal can undo it. */
  protected track(unsubscribe: () => void): void {
    this.#unsubscribes.push(unsubscribe);
  }

  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    this.queue.dispose();
  }
}

/**
 * HAP silently drops an accessory whose SerialNumber is over 64 characters.
 * An IEEE address is never close, but the guard costs nothing.
 */
export const usableSerial = (ieee: string): string =>
  ieee.length > 0 && ieee.length <= MAX_SERIAL_LENGTH ? ieee : ieee.slice(0, MAX_SERIAL_LENGTH);
