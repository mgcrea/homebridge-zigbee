/**
 * A Zigbee light as a HomeKit Lightbulb.
 *
 * The interesting part of this file is not the characteristic wiring, it is
 * what happens between HomeKit's writes and the radio. HomeKit has no notion of
 * "set this light to warm white at 40%": dragging the colour wheel writes Hue
 * and Saturation as two separate characteristics, and activating a scene writes
 * On, Brightness and ColorTemperature within the same few milliseconds. Sent
 * straight through, each of those becomes its own Zigbee command and the bulb
 * visibly steps through the intermediate states.
 *
 * So writes are accumulated into a pending record and flushed once, as the
 * shortest command sequence that reaches the requested state.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { Models } from "zigbee-herdsman";

import { BaseAccessory } from "#accessories/base-accessory";
import { CLUSTER, COLOR_MODE } from "#model/capability";
import type { DeviceView } from "#model/device";
import type { StateChange } from "#model/state";
import type { ZigbeePlatform } from "#platform";
import {
  attributesToXy,
  hueSatToXy,
  levelToPercent,
  percentToLevel,
  xyToAttributes,
  xyToHueSat,
} from "#util/color";
import { describe } from "#util/describe";

/** All pending writes flush together, so they share one key. */
const APPLY_KEY = "apply";

type Pending = {
  on?: boolean;
  level?: number;
  mireds?: number;
  hue?: number;
  saturation?: number;
};

export class LightAccessory extends BaseAccessory {
  readonly #service: Service;
  #pending: Pending = {};

  constructor(
    platform: ZigbeePlatform,
    accessory: PlatformAccessory,
    view: DeviceView,
    endpoint: Models.Endpoint,
  ) {
    super(platform, accessory, view, endpoint);

    const { Service: HapService, Characteristic } = platform;
    this.#service =
      this.accessory.getService(HapService.Lightbulb) ??
      this.accessory.addService(HapService.Lightbulb, this.displayName);

    this.configureInformation();

    this.#service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#readOn())
      .onSet((value) => this.#writeOn(value));

    if (view.capabilities.has("brightness")) {
      this.#service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.#readBrightness())
        .onSet((value) => this.#writeBrightness(value));
    }

    if (view.miredRange) {
      this.#service
        .getCharacteristic(Characteristic.ColorTemperature)
        // A characteristic whose props sit outside HomeKit's own 140-500 range
        // is rejected outright, taking the service with it, so the range comes
        // from the bulb's physical bounds already clamped into HomeKit's.
        .setProps({ minValue: view.miredRange.min, maxValue: view.miredRange.max })
        .onGet(() => this.#readMireds())
        .onSet((value) => this.#writeMireds(value));
    }

    if (view.capabilities.has("color")) {
      this.#service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => this.#readHueSat().hue)
        .onSet((value) => this.#writeHue(value));

      this.#service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() => this.#readHueSat().saturation)
        .onSet((value) => this.#writeSaturation(value));
    }

    this.track(
      this.platform.state.subscribe(this.view.key, (change) => {
        this.#onStateChange(change);
      }),
    );
  }

  protected override get isReadable(): boolean {
    return this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") !== undefined;
  }

  // ---------------------------------------------------------------- reads

  #readOn(): boolean {
    this.assertReadable();
    return this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false;
  }

  #readBrightness(): number {
    this.assertReadable();
    const level = this.platform.state.readNumber(this.view.key, CLUSTER.level, "currentLevel");
    return level === undefined ? 100 : levelToPercent(level);
  }

  #readMireds(): number {
    this.assertReadable();
    const range = this.view.miredRange;
    const mireds = this.platform.state.readNumber(this.view.key, CLUSTER.color, "colorTemperature");
    if (mireds === undefined || !range) return range?.min ?? 140;
    return Math.min(range.max, Math.max(range.min, mireds));
  }

  #readHueSat(): { hue: number; saturation: number } {
    this.assertReadable();
    const x = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentX");
    const y = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentY");
    if (x === undefined || y === undefined) return { hue: 0, saturation: 0 };
    return xyToHueSat(attributesToXy(x, y));
  }

  // --------------------------------------------------------------- writes

  #writeOn(value: CharacteristicValue): void {
    this.#pending.on = value === true;
    this.#schedule();
  }

  #writeBrightness(value: CharacteristicValue): void {
    this.#pending.level = percentToLevel(Number(value));
    // HomeKit sends Brightness without On when raising a light from off. The
    // command used below turns the light on as a side effect, and saying so
    // here keeps the flush from also sending a redundant `on`.
    this.#pending.on = true;
    this.#schedule();
  }

  #writeMireds(value: CharacteristicValue): void {
    this.#pending.mireds = Math.round(Number(value));
    // Colour temperature and colour are the same lamp: asking for one has to
    // cancel a pending request for the other.
    delete this.#pending.hue;
    delete this.#pending.saturation;
    this.#schedule();
  }

  #writeHue(value: CharacteristicValue): void {
    this.#pending.hue = Number(value);
    delete this.#pending.mireds;
    this.#schedule();
  }

  #writeSaturation(value: CharacteristicValue): void {
    this.#pending.saturation = Number(value);
    delete this.#pending.mireds;
    this.#schedule();
  }

  #schedule(): void {
    this.queue.coalesce(APPLY_KEY, async () => {
      const pending = this.#pending;
      this.#pending = {};
      await this.#apply(pending);
    });
  }

  /**
   * Turn a pending record into the fewest commands that reach it.
   *
   * Order is deliberate. Turning off makes everything else moot. Colour is sent
   * before the light comes on, because Hue bulbs accept colour while off and
   * apply it on the way up — sending it afterwards makes the bulb flash its
   * previous colour first. `moveToLevelWithOnOff` then covers both brightness
   * and switching on, so no separate `on` is needed alongside it.
   */
  async #apply(pending: Pending): Promise<void> {
    const transition = Math.round(this.platform.config.transitionTime * 10);

    try {
      if (pending.on === false) {
        await this.endpoint.command("genOnOff", "off", {});
        return;
      }

      if (pending.mireds !== undefined) {
        await this.endpoint.command("lightingColorCtrl", "moveToColorTemp", {
          colortemp: pending.mireds,
          transtime: transition,
        });
      } else if (pending.hue !== undefined || pending.saturation !== undefined) {
        // Only one of the two arrived if the user nudged a single slider, so
        // the other comes from what the light currently shows.
        const current = this.#currentHueSat();
        const xy = hueSatToXy({
          hue: pending.hue ?? current.hue,
          saturation: pending.saturation ?? current.saturation,
        });
        await this.endpoint.command("lightingColorCtrl", "moveToColor", {
          ...xyToAttributes(xy),
          transtime: transition,
        });
      }

      if (pending.level !== undefined) {
        await this.endpoint.command("genLevelCtrl", "moveToLevelWithOnOff", {
          level: pending.level,
          transtime: transition,
        });
      } else if (pending.on === true) {
        await this.endpoint.command("genOnOff", "on", {});
      }
    } catch (error) {
      this.platform.log.warn(`${this.displayName} did not accept the change: ${describe(error)}`);
    }
  }

  /**
   * Whether the light's `colorTemperature` attribute currently means anything.
   *
   * A light in xy mode keeps answering reads of `colorTemperature` with whatever
   * it held when it was last in colour-temperature mode. Observed on a Hue Play
   * showing full blue and reporting 153 mired — pushed to HomeKit unguarded,
   * that renders a blue lamp as cool white.
   *
   * A light that never reports `colorMode` at all is trusted, because a
   * colour-temperature-only bulb has nothing to confuse it with.
   */
  #colorTemperatureIsMeaningful(): boolean {
    const mode = this.platform.state.readNumber(this.view.key, CLUSTER.color, "colorMode");
    return mode === undefined || mode === COLOR_MODE.colorTemperature;
  }

  /** Like `#readHueSat`, but never throws — the flush path has no HomeKit call to fail. */
  #currentHueSat(): { hue: number; saturation: number } {
    const x = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentX");
    const y = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentY");
    if (x === undefined || y === undefined) return { hue: 0, saturation: 0 };
    return xyToHueSat(attributesToXy(x, y));
  }

  // --------------------------------------------------------------- updates

  #onStateChange(change: StateChange): void {
    const { Characteristic } = this.platform;

    if (change.cluster === CLUSTER.onOff && change.changed.has("onOff")) {
      this.#service.updateCharacteristic(
        Characteristic.On,
        this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false,
      );
    }

    if (change.cluster === CLUSTER.level && change.changed.has("currentLevel")) {
      const level = this.platform.state.readNumber(this.view.key, CLUSTER.level, "currentLevel");
      if (level !== undefined) {
        this.#service.updateCharacteristic(Characteristic.Brightness, levelToPercent(level));
      }
    }

    if (change.cluster !== CLUSTER.color) return;

    if (
      (change.changed.has("colorTemperature") || change.changed.has("colorMode")) &&
      this.view.miredRange &&
      this.#colorTemperatureIsMeaningful()
    ) {
      this.#service.updateCharacteristic(Characteristic.ColorTemperature, this.#readMiredsQuiet());
    }

    // Both axes come from the same xy pair, so either one moving refreshes both.
    if (
      this.view.capabilities.has("color") &&
      (change.changed.has("currentX") ||
        change.changed.has("currentY") ||
        change.changed.has("colorMode"))
    ) {
      const { hue, saturation } = this.#currentHueSat();
      this.#service.updateCharacteristic(Characteristic.Hue, hue);
      this.#service.updateCharacteristic(Characteristic.Saturation, saturation);
    }
  }

  #readMiredsQuiet(): number {
    const range = this.view.miredRange;
    const mireds = this.platform.state.readNumber(this.view.key, CLUSTER.color, "colorTemperature");
    if (mireds === undefined || !range) return range?.min ?? 140;
    return Math.min(range.max, Math.max(range.min, mireds));
  }

  update(view: DeviceView): void {
    this.view = view;
  }
}
