/**
 * A switch that opens the network to new devices.
 *
 * A Homebridge plugin has no interface of its own, and pairing needs a person
 * to press something at the moment the bulb is listening. The alternative is
 * stopping the bridge to run a script, which takes every other accessory in the
 * house down with it — so the control lives in the Home app, as a switch that
 * turns itself off when the window closes.
 *
 * It is a real switch with a real side effect, so it defaults to visible but
 * can be turned off entirely in the config for anyone who would rather pair
 * from the command line.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import type { ZigbeePlatform } from "#platform";
import { describe } from "#util/describe";

export class PairingSwitch {
  readonly #service: Service;
  #open = false;

  constructor(
    private readonly platform: ZigbeePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service: HapService, Characteristic } = platform;

    const information =
      this.accessory.getService(HapService.AccessoryInformation) ??
      this.accessory.addService(HapService.AccessoryInformation);
    information
      .setCharacteristic(Characteristic.Manufacturer, "mgcrea")
      .setCharacteristic(Characteristic.Model, "Zigbee Pairing")
      .setCharacteristic(Characteristic.SerialNumber, "pairing");

    this.#service =
      this.accessory.getService(HapService.Switch) ??
      this.accessory.addService(HapService.Switch, "Zigbee Pairing");

    this.#service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.#open)
      .onSet(async (value) => await this.#set(value));
  }

  /** Reflect what the controller actually did, whoever asked for it. */
  setOpen(open: boolean): void {
    this.#open = open;
    this.#service.updateCharacteristic(this.platform.Characteristic.On, open);
  }

  /**
   * Returned, not fired and forgotten.
   *
   * hap takes the handler resolving as the write having succeeded, so voiding
   * the promise meant the switch always reported success — including when the
   * coordinator was not connected and nothing had been opened at all.
   */
  async #set(value: CharacteristicValue): Promise<void> {
    await this.#apply(value === true);
  }

  async #apply(wanted: boolean): Promise<void> {
    const controller = this.platform.controller;
    if (!controller) {
      this.platform.log.warn("Cannot change pairing: the coordinator is not connected.");
      this.setOpen(false);
      // -70402 is `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, spelled
      // numerically for the same reason it is in the base accessory. Without
      // it the Home app shows the switch as having turned on while the network
      // is still shut.
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    try {
      const seconds = wanted ? this.platform.config.permitJoinDuration : 0;
      await controller.permitJoin(seconds);

      if (wanted) {
        this.platform.log.info(
          `Pairing is open for ${seconds}s. Put the device into pairing mode now. ` +
            "A Hue bulb already paired to a Hue bridge must be factory reset first: delete it " +
            "in the Hue app, or power cycle it off 2s / on 8s, five times over.",
        );
      } else {
        this.platform.log.info("Pairing closed.");
      }
      this.setOpen(wanted);
    } catch (error) {
      this.platform.log.error(`Could not change pairing: ${describe(error)}`);
      this.setOpen(false);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
