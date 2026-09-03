/**
 * A device whose only trick is `genOnOff` — a smart plug, an inline relay.
 *
 * Exposed as an Outlet rather than a Switch: HomeKit renders the two almost
 * identically, but Siri and the Home app treat an Outlet as a socket, which is
 * what these actually are.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { Models } from "zigbee-herdsman";

import { BaseAccessory } from "#accessories/base-accessory";
import { CLUSTER } from "#model/capability";
import type { DeviceView } from "#model/device";
import type { StateChange } from "#model/state";
import type { ZigbeePlatform } from "#platform";
import { isNoAnswer } from "#util/describe";

const APPLY_KEY = "apply";

export class OutletAccessory extends BaseAccessory {
  readonly #service: Service;
  #desired: boolean | undefined;

  constructor(
    platform: ZigbeePlatform,
    accessory: PlatformAccessory,
    view: DeviceView,
    endpoint: Models.Endpoint,
  ) {
    super(platform, accessory, view, endpoint);

    const { Service: HapService, Characteristic } = platform;
    this.#service =
      this.accessory.getService(HapService.Outlet) ??
      this.accessory.addService(HapService.Outlet, this.displayName);

    this.configureInformation();

    this.#service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#readOn())
      .onSet((value) => this.#writeOn(value));

    this.track(
      this.platform.state.subscribe(this.view.key, (change) => {
        this.#onStateChange(change);
      }),
    );
  }

  protected override get isReadable(): boolean {
    return this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") !== undefined;
  }

  #readOn(): boolean {
    this.assertReadable();
    return this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false;
  }

  #writeOn(value: CharacteristicValue): void {
    this.#desired = value === true;
    this.queue.coalesce(APPLY_KEY, async () => {
      const on = this.#desired;
      if (on === undefined) return;
      if (this.declineWhileUnreachable("the change")) return;
      try {
        await this.endpoint.command("genOnOff", on ? "on" : "off", {});
        // Record what the command asked for, so a read landing before the
        // device's own report does not hand HomeKit the pre-command value
        // back and make the tile flick to its old position. The report still
        // arrives and still wins; this only covers the gap.
        this.platform.state.apply(this.view.key, CLUSTER.onOff, { onOff: on });
        this.noteRadioOutcome(true);
      } catch (error) {
        this.noteRadioOutcome(!isNoAnswer(error));
        this.reportCommandFailure("did not switch", error);
      }
    });
  }

  #onStateChange(change: StateChange): void {
    if (change.cluster !== CLUSTER.onOff || !change.changed.has("onOff")) return;
    this.#service.updateCharacteristic(
      this.platform.Characteristic.On,
      this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false,
    );
  }

  update(view: DeviceView, endpoint: Models.Endpoint): void {
    this.view = view;
    this.adoptEndpoint(endpoint);
  }

  protected override publishFromStore(): void {
    if (!this.isReadable) return;
    this.#service.updateCharacteristic(
      this.platform.Characteristic.On,
      this.platform.state.readBoolean(this.view.key, CLUSTER.onOff, "onOff") ?? false,
    );
  }
}
