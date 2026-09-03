import type { PlatformAccessory } from "homebridge";
import type { Models } from "zigbee-herdsman";

import type { DeviceView } from "#model/device";
import { DeviceQueue } from "#model/queue";
import type { ZigbeePlatform } from "#platform";
import { describeCommandFailure } from "#util/describe";
import { refresh } from "#zigbee/reporting";

/** HAP refuses a SerialNumber longer than this, and drops the whole accessory. */
const MAX_SERIAL_LENGTH = 64;

/** Consecutive unanswered attempts before a device is treated as gone. */
const FAILURES_BEFORE_UNREACHABLE = 3;

/**
 * How rarely a silent device is probed, at the most.
 *
 * Eight cycles is forty minutes at the default interval. Rarer than that and a
 * lamp whose power came back would sit unresponsive long enough for someone to
 * go looking for the bug.
 */
const MAX_POLL_BACKOFF_CYCLES = 8;

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
  /** Consecutive unanswered attempts; drives the warning and the send guard. */
  #consecutiveFailures = 0;
  /** When the most recent unanswered attempt happened. */
  #lastFailureAt = 0;
  /** Whether the outage has already been announced, so it is announced once. */
  #announced = false;
  /** How many poll cycles to sit out before probing a silent device again. */
  #pollBackoff = 0;
  /** Cycles sat out so far under the current back-off. */
  #cyclesSkipped = 0;

  constructor(
    protected readonly platform: ZigbeePlatform,
    protected readonly accessory: PlatformAccessory,
    protected view: DeviceView,
    protected endpoint: Models.Endpoint,
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

    // An unreachable device is still probed, deliberately: a device whose
    // reporting configuration did not survive its power cycle will never speak
    // first, so if we stop asking entirely it stays unreachable for good.
    //
    // But every probe is a ten-second timeout on a radio that runs one
    // transaction at a time, so the whole house waits behind each one. The gap
    // therefore doubles while the silence lasts — one cycle, then two, four and
    // eight — and collapses the instant anything is heard. A person tapping the
    // tile is not subject to any of this; that write always goes out, and it is
    // the faster way back.
    if (this.unreachable) {
      if (this.#cyclesSkipped < this.#pollBackoff) {
        this.#cyclesSkipped += 1;
        return;
      }
      this.#cyclesSkipped = 0;
      this.#pollBackoff = Math.min(
        MAX_POLL_BACKOFF_CYCLES,
        this.#pollBackoff === 0 ? 1 : this.#pollBackoff * 2,
      );
    } else {
      this.#pollBackoff = 0;
      this.#cyclesSkipped = 0;
    }

    const reached = await this.queue.run(
      async () => await refresh(this.endpoint, this.platform.log),
    );
    this.noteRadioOutcome(reached);
  }

  /**
   * Whether it is worth putting anything on the radio for this device.
   *
   * A device that has not answered several attempts running is gone, and each
   * further command spends a full ten-second timeout rediscovering that. The
   * cost is not just the wasted send: the adapter is limited to one transaction
   * at a time, so every other device in the house queues behind it. Adaptive
   * Lighting made this plain — it drives colour temperature once a minute, so a
   * single lamp switched off at a garden relay produced a failed send every
   * minute all night, and the lamps that *were* reachable answered sluggishly
   * the whole time.
   *
   * Reads are untouched. They are answered from the store and go on being
   * refused by `assertReadable` while the device is stale, so the Home app
   * still shows "No Response" rather than a stale guess.
   */
  get unreachable(): boolean {
    if (this.#consecutiveFailures < FAILURES_BEFORE_UNREACHABLE) return false;

    // Anything heard since the last failed attempt settles it. An unsolicited
    // report is proof the device is back, and outranks a counter that
    // describes a moment which has since passed.
    const heard = this.platform.state.heardAt(this.key);
    return heard === undefined || heard <= this.#lastFailureAt;
  }

  /**
   * Skip a command for a device that is not answering, and put the Home app
   * back where the house actually is.
   *
   * Returns whether the command was skipped, so the caller can stop. The log
   * line is at debug: the outage was already announced once by
   * `noteRadioOutcome`, and Adaptive Lighting alone would otherwise write a
   * line a minute for as long as the lamp stays off.
   */
  protected declineWhileUnreachable(action: string): boolean {
    if (!this.unreachable) return false;

    this.platform.log.debug(
      `${this.displayName} is not answering, so ${action} was not sent to the radio.`,
    );
    this.publishFromStore();
    return true;
  }

  /**
   * Record the outcome of something that went to the radio, and say when a
   * device stops answering — once — and when it comes back.
   *
   * Refreshes and commands both feed this, because both are equally good
   * evidence about whether the device is there. A command the device *refused*
   * counts as reached: it answered, and it said no.
   *
   * Individual failures are logged at debug, which is off by default, so a
   * device that had quietly stopped answering produced no visible output at
   * all. Announcing the transition rather than every failure keeps a long
   * outage from becoming thousands of identical lines.
   */
  protected noteRadioOutcome(reached: boolean): void {
    if (reached) {
      if (this.#announced) {
        this.platform.log.info(`${this.displayName} is responding again.`);
        this.#announced = false;
      }
      this.#consecutiveFailures = 0;
      return;
    }

    this.#consecutiveFailures += 1;
    this.#lastFailureAt = Date.now();

    if (this.#consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE && !this.#announced) {
      this.#announced = true;
      this.platform.log.warn(
        `${this.displayName} has not answered ${FAILURES_BEFORE_UNREACHABLE} attempts in a row. ` +
          "It will show as unresponsive in the Home app, automations will stop writing to it, " +
          "and it will be probed less and less often, so that one absent device does not slow " +
          "the rest of the house down. Tapping its tile still reaches the radio and is the " +
          "quickest way to find out it is back. The usual cause is that it has lost power — a " +
          "lamp switched off at the wall or on a relay looks exactly like this — and the next " +
          "likeliest is that it is out of range.",
      );
    }
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

  /**
   * Push every characteristic back from the store.
   *
   * Called when a command failed, and for one specific reason. HomeKit sets a
   * characteristic to the requested value the moment the user acts on it, and
   * the write handler returning is taken as confirmation. If the radio command
   * then fails, nothing ever contradicts that: the lamp stays on, and the Home
   * app goes on showing it off, indefinitely. Writing the store's values back
   * puts the tile in front of the user back in step with the house.
   */
  protected abstract publishFromStore(): void;

  /**
   * Report a command that the device did not carry out, and undo the optimism.
   *
   * The summary is deliberately short; the full herdsman text carries the APS
   * frame and every option the command was sent with, which belongs at debug.
   */
  protected reportCommandFailure(action: string, error: unknown): void {
    this.platform.log.warn(`${this.displayName} ${action}: ${describeCommandFailure(error)}.`);
    this.platform.log.debug(`${this.displayName} ${action}, in full:`, error);
    this.publishFromStore();
  }

  /** Re-point the accessory at a freshly resolved endpoint. */
  protected adoptEndpoint(endpoint: Models.Endpoint): void {
    this.endpoint = endpoint;
  }

  /**
   * Whether what we hold is recent enough to answer with.
   *
   * A mains-powered device that has said nothing for hours is not idle, it is
   * unreachable — and answering with the values it last reported is a
   * confident wrong answer about the house. Both lights sat silent for twelve
   * hours while HomeKit cheerfully showed yesterday's brightness, and the only
   * way to discover it was to read the logs.
   *
   * Battery devices are exempt. They sleep for hours by design and are never
   * polled, so silence says nothing about them.
   */
  protected get isFresh(): boolean {
    if (!this.view.mainsPowered) return true;

    const age = this.platform.state.ageMs(this.view.key);
    return age !== undefined && age <= this.platform.staleAfterMs;
  }

  protected assertReadable(): void {
    if (!this.isReadable || !this.isFresh) {
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
