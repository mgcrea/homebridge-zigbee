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
import type {
  AdaptiveLightingController,
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge";
import type { Models } from "zigbee-herdsman";

import { BaseAccessory } from "#accessories/base-accessory";
import { CLUSTER, COLOR_MODE } from "#model/capability";
import { HOMEKIT_MIRED_MIN, type DeviceView, type MiredRange } from "#model/device";
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
import { isNoAnswer } from "#util/describe";

/** All pending writes flush together, so they share one key. */
const APPLY_KEY = "apply";

/**
 * `AdaptiveLightingControllerMode.AUTOMATIC`.
 *
 * Spelled numerically because the enum is an ambient const enum, which
 * `verbatimModuleSyntax` forbids reaching into at runtime — the same reason
 * `HAPStatus` appears as -70402 in the base accessory.
 *
 * hap-nodejs recommends MANUAL mode for lights that run transitions on the
 * device, which this one does. AUTOMATIC is chosen anyway: it drives the
 * schedule by calling the ColorTemperature SET handler once a minute, which
 * costs a single command and flows through the same coalescing and throttling
 * as any other write. MANUAL would mean re-implementing the transition curve,
 * its brightness adjustment and its notification thresholds by hand, for one
 * command a minute we are already able to absorb.
 */
const ADAPTIVE_LIGHTING_AUTOMATIC = 1;

type Pending = {
  on?: boolean;
  level?: number;
  mireds?: number;
  hue?: number;
  saturation?: number;
  /**
   * Whether every write in this batch came from Adaptive Lighting rather than
   * from a person.
   *
   * The distinction decides what happens when the device has stopped
   * answering. An automated write to a silent lamp is pure waste — the
   * schedule will be back in sixty seconds regardless — but a user's tap is
   * the best probe there is, and the moment it succeeds the lamp is back.
   * Declining those left a tile that did nothing until the next poll.
   */
  automated?: boolean;
};

/**
 * hap-nodejs types the SET handler's context as `any`; nothing here needs more
 * than "some value that may or may not be an object".
 */
type WriteContext = unknown;

/**
 * Whether a characteristic write came from the Adaptive Lighting controller.
 *
 * hap-nodejs tags the writes its own schedule makes with `{ controller }` and
 * passes the context straight through to the SET handler, which is the only
 * thing separating them from a person tapping the tile. This is the same test
 * hap-nodejs applies internally.
 */
const isAutomated = (context: WriteContext): boolean =>
  typeof context === "object" && context !== null && "controller" in context;

export class LightAccessory extends BaseAccessory {
  readonly #service: Service;
  /**
   * The colour-temperature bounds the ColorTemperature characteristic was
   * created with.
   *
   * Deliberately captured once rather than read from `view` on each use. A
   * later rediscovery can produce a *degraded* view — `describeEndpoint`
   * cannot read `colorCapabilities` from a light that is momentarily
   * unreachable, and correctly declines to guess — but the characteristic has
   * already been added and cannot be removed. Reading the bounds from the view
   * then yielded the 140 mired fallback and HomeKit rejected it: "supplied
   * illegal value: number 140 exceeded minimum of 153".
   */
  readonly #miredRange: MiredRange | undefined;
  #pending: Pending = {};
  /**
   * A colour temperature asked for while the light was off.
   *
   * Adaptive Lighting drives colour temperature once a minute whether or not
   * the light is on, and hap-nodejs never checks `On` before calling the SET
   * handler. Sending those is pointless — the lamp is dark — and on a lamp that
   * is off at a relay it is worse than pointless, because the adapter runs one
   * transaction at a time and every other device queues behind the timeout.
   *
   * So the value is kept here instead and folded into whichever command next
   * turns the light on, where it costs nothing: colour already precedes `on`,
   * so the lamp comes up at the right temperature rather than flashing its
   * previous one on the way.
   */
  #deferredMireds: number | undefined;
  #adaptiveLighting: AdaptiveLightingController | undefined;

  constructor(
    platform: ZigbeePlatform,
    accessory: PlatformAccessory,
    view: DeviceView,
    endpoint: Models.Endpoint,
  ) {
    super(platform, accessory, view, endpoint);
    this.#miredRange = view.miredRange;

    const { Service: HapService, Characteristic } = platform;
    this.#service =
      this.accessory.getService(HapService.Lightbulb) ??
      this.accessory.addService(HapService.Lightbulb, this.displayName);

    this.configureInformation();

    this.#service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#readOn())
      .onSet((value, context) => this.#writeOn(value, context));

    if (view.capabilities.has("brightness")) {
      this.#service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.#readBrightness())
        .onSet((value, context) => this.#writeBrightness(value, context));
    }

    if (view.miredRange) {
      this.#service
        .getCharacteristic(Characteristic.ColorTemperature)
        // A characteristic whose props sit outside HomeKit's own 140-500 range
        // is rejected outright, taking the service with it, so the range comes
        // from the bulb's physical bounds already clamped into HomeKit's.
        .setProps({ minValue: view.miredRange.min, maxValue: view.miredRange.max })
        .onGet(() => this.#readMireds())
        .onSet((value, context) => this.#writeMireds(value, context));
    }

    if (view.capabilities.has("color")) {
      this.#service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => this.#readHueSat().hue)
        .onSet((value, context) => this.#writeHue(value, context));

      this.#service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() => this.#readHueSat().saturation)
        .onSet((value, context) => this.#writeSaturation(value, context));
    }

    this.#configureAdaptiveLighting();

    this.track(
      this.platform.state.subscribe(this.view.key, (change) => {
        this.#onStateChange(change);
      }),
    );
  }

  /**
   * Offer Apple's Adaptive Lighting, which drifts colour temperature warm
   * through the evening on its own.
   *
   * HomeKit only accepts it on a Lightbulb that has both Brightness and
   * ColorTemperature, which is exactly what the cluster-driven discovery
   * derives for a colour-temperature-capable light — so nothing extra needs
   * detecting here.
   */
  #configureAdaptiveLighting(): void {
    if (!this.platform.config.adaptiveLighting) return;
    if (!this.view.capabilities.has("brightness") || !this.view.miredRange) return;

    this.#adaptiveLighting = new this.platform.api.hap.AdaptiveLightingController(this.#service, {
      controllerMode: ADAPTIVE_LIGHTING_AUTOMATIC,
    });
    this.accessory.configureController(this.#adaptiveLighting);
  }

  /**
   * Keep the colour characteristics consistent with each other.
   *
   * ColorTemperature and Hue/Saturation describe the same lamp two ways, and
   * the Adaptive Lighting controller reads both. Writing one has to move the
   * other, and it must be done with `updateValue` rather than `setValue`: a
   * `setValue` counts as a write from HomeKit and switches Adaptive Lighting
   * off, which is precisely what its own schedule would then do to itself
   * every sixty seconds.
   */
  #mirrorColorTemperature(mireds: number): void {
    if (!this.view.capabilities.has("color")) return;
    const { hue, saturation } =
      this.platform.api.hap.ColorUtils.colorTemperatureToHueAndSaturation(mireds);
    this.#service.updateCharacteristic(this.platform.Characteristic.Hue, hue);
    this.#service.updateCharacteristic(this.platform.Characteristic.Saturation, saturation);
  }

  /** The mirror image: choosing a colour parks colour temperature at its lowest. */
  #parkColorTemperature(): void {
    const range = this.#miredRange;
    if (!range) return;
    this.#service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, range.min);
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
    // A light in xy mode goes on answering reads of `colorTemperature` with
    // whatever it held when it was last in colour-temperature mode. The other
    // two paths already refuse to trust that; this one reported it straight to
    // the Home app, which showed a blue lamp as cool white. Report the value a
    // colour write parks the characteristic at instead.
    if (!this.#colorTemperatureIsMeaningful()) {
      return this.#miredRange?.min ?? HOMEKIT_MIRED_MIN;
    }
    return this.#readMiredsQuiet();
  }

  #readHueSat(): { hue: number; saturation: number } {
    this.assertReadable();
    const x = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentX");
    const y = this.platform.state.readNumber(this.view.key, CLUSTER.color, "currentY");
    if (x === undefined || y === undefined) return { hue: 0, saturation: 0 };
    return xyToHueSat(attributesToXy(x, y));
  }

  // --------------------------------------------------------------- writes

  #writeOn(value: CharacteristicValue, context: WriteContext): void {
    this.#pending.on = value === true;
    this.#schedule(context);
  }

  #writeBrightness(value: CharacteristicValue, context: WriteContext): void {
    const level = percentToLevel(Number(value));
    this.#pending.level = level;
    // HomeKit sends Brightness without On when raising a light from off, and
    // the command used below turns the light on as a side effect, so saying so
    // here keeps the flush from also sending a redundant `on`.
    //
    // Brightness *zero* is the opposite request. Claiming `on` for it used to
    // cancel an `On = false` that arrived in the same coalescing window, so
    // switching a light off from a scene that also set its brightness turned
    // it on instead. An explicit off always wins.
    if (level > 0 && this.#pending.on !== false) this.#pending.on = true;
    this.#schedule(context);
  }

  #writeMireds(value: CharacteristicValue, context: WriteContext): void {
    const mireds = Math.round(Number(value));
    // Mirror regardless of whether anything is sent: Hue and Saturation
    // describe the same lamp, the Adaptive Lighting controller reads both, and
    // a deferred value still has to leave the Home app showing the right thing.
    this.#mirrorColorTemperature(mireds);
    // Colour temperature and colour are the same lamp: asking for one has to
    // cancel a pending request for the other.
    delete this.#pending.hue;
    delete this.#pending.saturation;

    if (!this.#willBeOn(this.#pending)) {
      // Nothing to light. Hold the value for whichever command turns the lamp
      // on next, and put nothing on the radio.
      this.#deferredMireds = mireds;
      delete this.#pending.mireds;
      return;
    }

    this.#pending.mireds = mireds;
    this.#schedule(context);
  }

  #writeHue(value: CharacteristicValue, context: WriteContext): void {
    this.#pending.hue = Number(value);
    delete this.#pending.mireds;
    this.#deferredMireds = undefined;
    this.#parkColorTemperature();
    this.#schedule(context);
  }

  #writeSaturation(value: CharacteristicValue, context: WriteContext): void {
    this.#pending.saturation = Number(value);
    delete this.#pending.mireds;
    this.#deferredMireds = undefined;
    this.#parkColorTemperature();
    this.#schedule(context);
  }

  /**
   * Whether the pending batch leaves the light on.
   *
   * What it asks for outranks what the store holds, and the store only counts
   * when it is recent enough to mean anything: a light nothing has been heard
   * from is treated as off, which is the safe direction — the value is held
   * rather than spent on a radio timeout, and the next command that does turn
   * the light on carries it.
   */
  #willBeOn(pending: Pending): boolean {
    if (pending.on !== undefined) return pending.on;
    if (pending.level !== undefined) return pending.level > 0;
    if (!this.isFresh) return false;
    return this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false;
  }

  #schedule(context: WriteContext): void {
    // A batch counts as automated only while every write in it was. One tap
    // from a person makes the whole flush a probe worth spending radio on.
    this.#pending.automated = (this.#pending.automated ?? true) && isAutomated(context);

    this.queue.coalesce(APPLY_KEY, async () => {
      const pending = this.#pending;
      this.#pending = {};

      if (pending.mireds === undefined && this.#willBeOn(pending)) {
        // A colour temperature held back while the light was off rides out
        // with the command that turns it on, at no extra cost: `#apply` sends
        // colour first, so the lamp comes up already at the right temperature.
        if (this.#deferredMireds !== undefined) pending.mireds = this.#deferredMireds;
      }
      if (pending.mireds !== undefined) this.#deferredMireds = undefined;

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
    // Only the scheduled writes are declined. A person tapping the tile is the
    // best probe there is, and the success resets the counter through the same
    // `noteRadioOutcome` every other command uses — so a lamp whose power came
    // back answers the first tap rather than waiting out a poll interval.
    if (pending.automated === true && this.declineWhileUnreachable("the change")) return;

    const transition = Math.round(this.platform.config.transitionTime * 10);
    // Only an attempt that actually reached the radio says anything about
    // whether the device is there; an empty pending record must not be taken
    // as proof of life.
    let sent = false;

    try {
      if (pending.on === false) {
        await this.endpoint.command("genOnOff", "off", {});
        sent = true;
        this.#confirm(CLUSTER.onOff, { onOff: false });
        this.noteRadioOutcome(true);
        return;
      }

      if (pending.mireds !== undefined) {
        await this.endpoint.command("lightingColorCtrl", "moveToColorTemp", {
          colortemp: pending.mireds,
          transtime: transition,
        });
        sent = true;
        this.#confirm(CLUSTER.color, {
          colorTemperature: pending.mireds,
          colorMode: COLOR_MODE.colorTemperature,
        });
      } else if (pending.hue !== undefined || pending.saturation !== undefined) {
        // Only one of the two arrived if the user nudged a single slider, so
        // the other comes from what the light currently shows.
        const current = this.#currentHueSat();
        const xy = hueSatToXy({
          hue: pending.hue ?? current.hue,
          saturation: pending.saturation ?? current.saturation,
        });
        const attributes = xyToAttributes(xy);
        await this.endpoint.command("lightingColorCtrl", "moveToColor", {
          ...attributes,
          transtime: transition,
        });
        sent = true;
        this.#confirm(CLUSTER.color, {
          currentX: attributes.colorx,
          currentY: attributes.colory,
          colorMode: COLOR_MODE.xy,
        });
      }

      if (pending.level !== undefined) {
        // `moveToLevelWithOnOff` at level 0 turns the light *off*, so a batch
        // that also asked for `on` — HomeKit's way of saying "on, as dim as it
        // goes" — has to be floored at 1 or it does the opposite.
        const level = pending.on === true ? Math.max(1, pending.level) : pending.level;
        await this.endpoint.command("genLevelCtrl", "moveToLevelWithOnOff", {
          level,
          transtime: transition,
        });
        sent = true;
        this.#confirm(CLUSTER.level, { currentLevel: level });
        // And when it was not floored, level 0 means the lamp is now off. The
        // store used to record `onOff: true` regardless, so setting brightness
        // to zero left the Home app showing a tile that was on.
        this.#confirm(CLUSTER.onOff, { onOff: level > 0 });
      } else if (pending.on === true) {
        await this.endpoint.command("genOnOff", "on", {});
        sent = true;
        this.#confirm(CLUSTER.onOff, { onOff: true });
      }

      if (sent) this.noteRadioOutcome(true);
    } catch (error) {
      // A refusal means the device answered, so it does not count against
      // reachability — only silence does.
      this.noteRadioOutcome(!isNoAnswer(error));
      this.reportCommandFailure("did not accept the change", error);
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

  /**
   * Record what a command just asked the light for.
   *
   * Without this the store keeps the pre-command value until the device's own
   * report arrives, and HomeKit reads the *old* value in the meantime. Seen as
   * a slider dragged from 90% to 40%: the lamp dims correctly, then the Home
   * app snaps back to 90% for a second or two before settling at 40% — the
   * lamp never moved, only the number did.
   *
   * The device's report still arrives and still wins; this only fills the gap
   * between commanding a change and being told it happened. It is applied
   * after the command resolves, so a refused command leaves the store honest.
   */
  #confirm(cluster: string, attributes: Readonly<Record<string, unknown>>): void {
    this.platform.state.apply(this.view.key, cluster, attributes);
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
      this.#miredRange &&
      this.#colorTemperatureIsMeaningful()
    ) {
      this.#service.updateCharacteristic(Characteristic.ColorTemperature, this.#readMiredsQuiet());
    }

    if (!this.view.capabilities.has("color")) return;

    // Both axes come from the same xy pair, so either one moving refreshes both.
    const xyMoved = change.changed.has("currentX") || change.changed.has("currentY");
    const modeMoved = change.changed.has("colorMode");

    if (xyMoved || (modeMoved && !this.#colorTemperatureIsMeaningful())) {
      const { hue, saturation } = this.#currentHueSat();
      this.#service.updateCharacteristic(Characteristic.Hue, hue);
      this.#service.updateCharacteristic(Characteristic.Saturation, saturation);
    } else if (modeMoved && this.#miredRange) {
      // The lamp moved *to* colour temperature. Hue and Saturation still have
      // to describe it, but the xy pair they would come from is the one it held
      // before the change — recomputing from that pushed the old colour back
      // over the mirror `#writeMireds` had just written, so a light going from
      // blue to warm white briefly turned blue again in the Home app.
      this.#mirrorColorTemperature(this.#readMiredsQuiet());
    }
  }

  #readMiredsQuiet(): number {
    const range = this.#miredRange;
    const mireds = this.platform.state.readNumber(this.view.key, CLUSTER.color, "colorTemperature");
    if (mireds === undefined || !range) return range?.min ?? 140;
    return Math.min(range.max, Math.max(range.min, mireds));
  }

  /**
   * Take a fresh description of the device.
   *
   * Capabilities are merged rather than replaced. A rediscovery that ran while
   * the light was unreachable comes back with fewer capabilities than the
   * first one found, and letting that through would leave characteristics on
   * the service with nothing backing them. A light does not stop being able to
   * do colour because we could not reach it for a moment.
   */
  update(view: DeviceView, endpoint: Models.Endpoint): void {
    this.view = {
      ...view,
      capabilities: new Set([...this.view.capabilities, ...view.capabilities]),
      miredRange: view.miredRange ?? this.view.miredRange,
    };
    this.adoptEndpoint(endpoint);
  }

  /**
   * Let go of the Adaptive Lighting controller along with everything else.
   *
   * It holds a timer that fires once a minute and a reference back to the
   * service, so an accessory unregistered while a transition was running went
   * on driving colour temperature into a light the plugin no longer has.
   */
  override dispose(): void {
    this.#deferredMireds = undefined;
    if (this.#adaptiveLighting) {
      this.accessory.removeController(this.#adaptiveLighting);
      this.#adaptiveLighting = undefined;
    }
    super.dispose();
  }

  /**
   * Every characteristic, straight from the store.
   *
   * `#onStateChange` updates only what a report said had moved, which is right
   * for the reporting path and wrong here: a failed command leaves HomeKit
   * holding a value nothing in the store ever agreed with, and there is no
   * report coming to correct it.
   */
  protected override publishFromStore(): void {
    if (!this.isReadable) return;
    const { Characteristic } = this.platform;

    this.#service.updateCharacteristic(
      Characteristic.On,
      this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false,
    );

    if (this.view.capabilities.has("brightness")) {
      const level = this.platform.state.readNumber(this.view.key, CLUSTER.level, "currentLevel");
      if (level !== undefined) {
        this.#service.updateCharacteristic(Characteristic.Brightness, levelToPercent(level));
      }
    }

    if (this.#miredRange && this.#colorTemperatureIsMeaningful()) {
      this.#service.updateCharacteristic(Characteristic.ColorTemperature, this.#readMiredsQuiet());
    }

    if (this.view.capabilities.has("color")) {
      const { hue, saturation } = this.#currentHueSat();
      this.#service.updateCharacteristic(Characteristic.Hue, hue);
      this.#service.updateCharacteristic(Characteristic.Saturation, saturation);
    }
  }
}
