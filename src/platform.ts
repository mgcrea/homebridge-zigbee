import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import type { Controller, Events, Models } from "zigbee-herdsman";

import { LightAccessory } from "#accessories/light-accessory";
import { OutletAccessory } from "#accessories/outlet-accessory";
import { PairingSwitch } from "#accessories/pairing-switch";
import { ConfigError, overrideFor, parseConfig, type ZigbeeConfig } from "#config";
import {
  type DeviceView,
  type EndpointProbe,
  probeEndpoint,
  storedProbe,
  viewFrom,
} from "#model/device";
import { StateStore, stateKey } from "#model/state";
import { ControllerSupervisor, NetworkResetError, resolvePaths } from "#zigbee/controller";
import { installHerdsmanLogger } from "#zigbee/logger";
import { configureReporting, isInterviewed, isMainsPowered } from "#zigbee/reporting";
import { PLATFORM_NAME, PLUGIN_NAME } from "#settings";
import { describe } from "#util/describe";

type AnyAccessory = LightAccessory | OutletAccessory;

/** The subtype the pairing switch is registered under. */
const PAIRING_UUID_SEED = "zigbee-pairing";

/** Never call a device stale sooner than this, however short the poll interval. */
const MIN_STALE_AFTER_S = 900;

/**
 * Dynamic platform: opens one Zigbee coordinator, mirrors the devices paired to
 * it into HomeKit, and keeps them in step from the attribute reports those
 * devices push.
 *
 * There is no poll loop in the normal case — reporting is configured at
 * discovery so the mesh volunteers changes. The periodic refresh exists only to
 * cover lights that refused reporting, and never runs for battery devices.
 */
export class ZigbeePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly state = new StateStore();

  readonly #config: ZigbeeConfig | undefined;
  readonly #cached = new Map<string, PlatformAccessory>();
  readonly #accessories = new Map<string, AnyAccessory>();
  /**
   * Re-arms in flight, by IEEE address.
   *
   * A Hue bulb announces itself several times on power-up, and each announce
   * used to start its own unserialised pass of five binds and a full refresh
   * against a radio that takes one request at a time.
   */
  readonly #rearming = new Map<string, Promise<void>>();
  /**
   * Endpoint state keys whose reporting is already arranged.
   *
   * Discovery runs again on every coordinator reconnect, and re-arming
   * reporting there is both pointless and actively harmful. Pointless because
   * the configuration lives in the *device's* binding table, aimed at a
   * coordinator whose address has not changed. Harmful because it is five
   * round trips per endpoint against an adapter that takes one request at a
   * time, so every command the user issues in the first minute after a
   * reconnect queues behind them — which is exactly how a reconnect at 05:47
   * turns into lights that "were a bit laggy initially".
   *
   * A power cycle *does* lose it on Hue bulbs, and that is what `deviceAnnounce`
   * and `#rearm` are for.
   */
  readonly #armed = new Set<string>();

  #supervisor: ControllerSupervisor | undefined;
  #controller: Controller | undefined;
  #pairing: PairingSwitch | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #shuttingDown = false;
  #discovering: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #rediscover = false;
  /**
   * Bumped whenever the controller is replaced.
   *
   * A discovery pass is a long sequence of awaits against a specific
   * controller. When the adapter drops halfway through, every remaining
   * request in that pass is aimed at a herdsman whose device cache has since
   * been rebuilt — and, worse, the pass would finish by calling `#removeStale`
   * with a half-filled `seen` set and unregister every accessory it had not
   * reached yet. Unregistering loses the room and scene assignments the user
   * made, permanently.
   */
  #epoch = 0;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    try {
      this.#config = parseConfig(config, (message) => {
        this.log.warn(message);
      });
    } catch (error) {
      // A misconfigured platform must not take Homebridge down with it; log
      // clearly and stay dormant so the rest of the bridge keeps working.
      this.log.error(
        error instanceof ConfigError ? error.message : `Invalid configuration: ${describe(error)}`,
      );
      return;
    }

    // Homebridge swallows nothing: an unhandled rejection out of either of
    // these takes the whole bridge down, and every other plugin with it.
    this.api.on("didFinishLaunching", () => {
      void this.#start().catch((error: unknown) => {
        this.log.error(`Zigbee platform could not start: ${describe(error)}`);
      });
    });
    this.api.on("shutdown", () => {
      void this.#stop().catch((error: unknown) => {
        this.log.error(`Zigbee platform did not shut down cleanly: ${describe(error)}`);
      });
    });
  }

  get config(): ZigbeeConfig {
    if (!this.#config) throw new Error("Platform is dormant: configuration was invalid.");
    return this.#config;
  }

  get controller(): Controller | undefined {
    return this.#controller;
  }

  /**
   * How quiet a mains-powered device may go before it reads as unreachable.
   *
   * Three refresh cycles: reporting is configured to speak at least hourly and
   * the refresh reads every cycle on top, so a healthy mains device is heard
   * every cycle. Missing three in a row is not a slow device, it is a gone one.
   * The floor keeps a very short configured interval from making HomeKit
   * flicker on one dropped frame.
   */
  get staleAfterMs(): number {
    return Math.max(this.config.refreshInterval * 3, MIN_STALE_AFTER_S) * 1000;
  }

  /** Homebridge replays every cached accessory here before launch completes. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.set(accessory.UUID, accessory);
  }

  async #start(): Promise<void> {
    const config = this.#config;
    if (!config) return;

    installHerdsmanLogger(this.log, config.debug);

    const paths = resolvePaths(this.api.user.persistPath());
    this.#supervisor = new ControllerSupervisor(config, paths, this.log, async (controller) => {
      this.#controller = controller;
      await this.#onControllerReady(controller);
    });

    try {
      await this.#supervisor.start();
    } catch (error) {
      // The supervisor retries transient failures itself and only lets a
      // deliberate refusal reach here.
      if (error instanceof NetworkResetError) {
        this.log.error(error.message);
        return;
      }
      this.log.error(`Zigbee platform could not start: ${describe(error)}`);
    }
  }

  async #onControllerReady(controller: Controller): Promise<void> {
    // A pass still running against the previous controller must not finish.
    this.#epoch += 1;

    controller.on("message", (payload) => {
      this.#onMessage(payload);
    });
    controller.on("deviceJoined", ({ device }) => {
      this.log.info(`${device.ieeeAddr} joined the network. Interviewing it.`);
    });
    controller.on("deviceInterview", ({ status, device }) => {
      if (status === "successful") {
        this.log.info(`${device.ieeeAddr} (${device.modelID ?? "unknown model"}) is ready.`);
        this.#scheduleDiscovery();
      } else if (status === "failed") {
        this.log.warn(
          `${device.ieeeAddr} failed its interview. Factory reset it and pair it again.`,
        );
      }
    });
    controller.on("deviceLeave", ({ ieeeAddr }) => {
      this.log.info(`${ieeeAddr} left the network.`);
      this.#scheduleDiscovery();
    });
    controller.on("deviceAnnounce", ({ device }) => {
      // A device that just re-announced has usually been power-cycled, and Hue
      // bulbs lose their reporting configuration when that happens.
      this.#scheduleRearm(device);
    });
    controller.on("lastSeenChanged", ({ device }) => {
      // herdsman sees traffic this platform never does — an announce, a route
      // record, the ACK on a command it routed. A device that only ever speaks
      // in those still read as stale here, and every HomeKit read of it came
      // back "No Response" while the thing was demonstrably on the network.
      for (const endpoint of device.endpoints) {
        this.state.touch(stateKey(device.ieeeAddr, endpoint.ID));
      }
    });
    controller.on("permitJoinChanged", ({ permitted }) => {
      this.#pairing?.setOpen(permitted);
    });

    this.#registerPairingSwitch();
    this.#scheduleDiscovery();
    this.#startRefreshTimer();
  }

  #onMessage(payload: Events.MessagePayload): void {
    if (typeof payload.cluster !== "string") return;
    if (payload.type !== "attributeReport" && payload.type !== "readResponse") return;
    if (Array.isArray(payload.data) || Buffer.isBuffer(payload.data)) return;

    const key = `${payload.device.ieeeAddr}/${payload.endpoint.ID}`;
    this.state.apply(key, payload.cluster, payload.data as Record<string, unknown>);
  }

  // ------------------------------------------------------------- discovery

  #scheduleDiscovery(): void {
    if (this.#discovering) {
      this.#rediscover = true;
      return;
    }
    this.#discovering = this.#discover()
      .catch((error: unknown) => {
        this.log.error(`Discovery failed: ${describe(error)}`);
      })
      .finally(() => {
        this.#discovering = undefined;
        if (this.#rediscover) {
          this.#rediscover = false;
          this.#scheduleDiscovery();
        }
      });
  }

  async #discover(): Promise<void> {
    const controller = this.#controller;
    if (!controller || this.#shuttingDown) return;

    // Everything below is checked against the controller and epoch this pass
    // started on, after every await.
    const epoch = this.#epoch;
    const abandoned = (): boolean =>
      this.#shuttingDown || this.#epoch !== epoch || this.#controller !== controller;

    const coordinator = controller.getDevicesByType("Coordinator")[0]?.getEndpoint(1);

    const seen = new Set<string>();

    for (const device of controller.getDevicesIterator((d) => d.type !== "Coordinator")) {
      const override = overrideFor(this.config, device.ieeeAddr);
      if (override?.exclude) continue;

      // Its endpoints and clusters are still whatever the interview has
      // collected so far, so anything read or bound against them is a round
      // trip spent on an answer that is about to change. herdsman retries the
      // interview on its own and the next pass will find it.
      if (!isInterviewed(device)) {
        this.log.debug(`${device.ieeeAddr} has not finished its interview; leaving it for now.`);
        continue;
      }

      const speakable = isMainsPowered(device);

      for (const endpoint of device.endpoints) {
        // An endpoint with no input clusters has nothing to control.
        if (endpoint.getInputClusters().length === 0) continue;

        const key = stateKey(device.ieeeAddr, endpoint.ID);
        const uuid = this.api.hap.uuid.generate(key);

        let view: DeviceView;
        let fresh: EndpointProbe | undefined;

        // The probe is the only part of a description that costs radio, and it
        // does not change for a device that is still the same device — so a
        // rediscovery of an adopted endpoint spends nothing. Before this, every
        // reconnect re-read two descriptions per endpoint on top of the binds.
        const remembered = storedProbe(this.#cached.get(uuid)?.context);
        if (remembered) {
          view = viewFrom(device, endpoint, remembered);
        } else {
          try {
            const probed = await probeEndpoint(device, endpoint, this.log);
            if (abandoned()) return;
            view = viewFrom(device, endpoint, probed.probe);
            // A probe taken while the light was unreachable describes the
            // outage, not the light. Caching that would make a moment's
            // silence permanent.
            if (probed.complete) fresh = probed.probe;
          } catch (error) {
            this.log.warn(`Could not describe ${device.ieeeAddr}: ${describe(error)}`);
            continue;
          }
        }

        if (view.capabilities.size === 0) continue;
        if (override?.name) view = { ...view, name: override.name };

        seen.add(uuid);
        this.#adopt(uuid, view, endpoint, fresh);

        // Battery devices are asleep almost all the time. Binding and reading
        // them fails, costs battery on the way, and is contradicted by the
        // reporting module's own contract — only `#refreshAll` used to honour
        // it.
        if (!speakable) continue;

        if (coordinator && !this.#armed.has(view.key)) {
          const outcome = await configureReporting(endpoint, coordinator, this.log);
          if (abandoned()) return;
          // An endpoint that arranged nothing at all was unreachable, not
          // unwilling; leaving it unmarked lets the next discovery try again.
          if (outcome.configured.length > 0) this.#armed.add(view.key);
        }

        // Populate state before HomeKit can ask, so the first read is a real
        // value rather than "No Response".
        await this.#accessories.get(uuid)?.refreshFromRadio();
        if (abandoned()) return;
      }
    }

    this.#removeStale(seen);
  }

  #adopt(
    uuid: string,
    view: DeviceView,
    endpoint: Models.Endpoint,
    probe: EndpointProbe | undefined,
  ): void {
    const existing = this.#accessories.get(uuid);
    if (existing) {
      // The endpoint matters as much as the view. herdsman rebuilds its device
      // objects when the controller is reopened, so an accessory that kept the
      // one it was constructed with is holding a stale handle onto a network
      // that has since been re-entered.
      existing.update(view, endpoint);
      this.#applyNameOverride(uuid, view);
      if (probe) this.#rememberProbe(uuid, probe);
      return;
    }

    const cached = this.#cached.get(uuid);
    const accessory = cached ?? new this.api.platformAccessory(view.name, uuid);
    accessory.context["key"] = view.key;
    if (probe) accessory.context["probe"] = probe;
    // A `devices[].name` added after the accessory was first registered never
    // reached it: the name is only used when the accessory is constructed, and
    // a cached one is not. Renaming in the Home app still wins, because that
    // changes the config the user would have to change back.
    if (this.config.devices.some((device) => device.name && device.ieee === view.ieee)) {
      accessory.displayName = view.name;
    }

    const instance = view.isLight
      ? new LightAccessory(this, accessory, view, endpoint)
      : new OutletAccessory(this, accessory, view, endpoint);

    this.#accessories.set(uuid, instance);

    if (cached) {
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info(`Adding ${view.name} (${view.ieee}).`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.#cached.set(uuid, accessory);
    }
  }

  /**
   * Push a `devices[].name` onto an accessory that was registered before it.
   */
  #applyNameOverride(uuid: string, view: DeviceView): void {
    const accessory = this.#cached.get(uuid);
    if (!accessory) return;
    if (!overrideFor(this.config, view.ieee)?.name) return;
    if (accessory.displayName === view.name) return;

    accessory.displayName = view.name;
    this.api.updatePlatformAccessories([accessory]);
  }

  /**
   * Keep the probe with the accessory, so the next start does not repeat it.
   *
   * `updatePlatformAccessories` is what makes Homebridge write the context out;
   * without it the probe would live only until the process ends, which is
   * exactly the run it needs to survive.
   */
  #rememberProbe(uuid: string, probe: EndpointProbe): void {
    const accessory = this.#cached.get(uuid);
    if (!accessory) return;
    if (storedProbe(accessory.context)) return;

    accessory.context["probe"] = probe;
    this.api.updatePlatformAccessories([accessory]);
  }

  /**
   * Drop accessories for devices that are no longer paired.
   *
   * Homebridge restores from its own cache, so an accessory left behind after
   * its device left the network stays in the Home app forever, backed by
   * nothing.
   */
  #removeStale(seen: ReadonlySet<string>): void {
    const pairingUuid = this.api.hap.uuid.generate(PAIRING_UUID_SEED);

    for (const [uuid, accessory] of this.#cached) {
      if (seen.has(uuid)) continue;
      if (uuid === pairingUuid && this.config.exposePairingSwitch) continue;

      this.log.info(`Removing ${accessory.displayName}, which is no longer paired.`);
      const gone = this.#accessories.get(uuid);
      if (gone) {
        this.#armed.delete(gone.key);
        // Nothing else will ever read this endpoint's values, and leaving them
        // behind means a device re-paired later starts from another device's
        // last known state.
        this.state.forget(gone.key);
        gone.dispose();
      }
      this.#accessories.delete(uuid);
      this.#cached.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  #registerPairingSwitch(): void {
    if (!this.config.exposePairingSwitch) return;

    // Reached again on every reconnect. Building a second PairingSwitch over
    // the same accessory would replace the handlers hap-nodejs already holds,
    // and it says so in the log each time it happens.
    if (!this.#pairing) {
      const uuid = this.api.hap.uuid.generate(PAIRING_UUID_SEED);
      const cached = this.#cached.get(uuid);
      const accessory = cached ?? new this.api.platformAccessory("Zigbee Pairing", uuid);
      this.#pairing = new PairingSwitch(this, accessory);

      if (cached) {
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.#cached.set(uuid, accessory);
      }
    }

    // The window may already be open if the bridge restarted while it was.
    this.#pairing.setOpen(this.#controller?.getPermitJoin() ?? false);
  }

  /**
   * Re-arm a device that has just re-announced itself, once.
   *
   * Hue bulbs announce several times on power-up. Each announce used to start
   * its own pass of five binds and a full refresh, unserialised, against an
   * adapter that runs one request at a time — so the bulb the user had just
   * switched on was the last thing the radio got to.
   */
  #scheduleRearm(device: Models.Device): void {
    const ieee = device.ieeeAddr;
    if (this.#rearming.has(ieee)) return;

    const task = this.#rearm(device)
      .catch((error: unknown) => {
        this.log.warn(`Could not re-arm ${ieee}: ${describe(error)}`);
      })
      .finally(() => {
        this.#rearming.delete(ieee);
      });

    this.#rearming.set(ieee, task);
  }

  async #rearm(device: Models.Device): Promise<void> {
    const coordinator = this.#controller?.getDevicesByType("Coordinator")[0]?.getEndpoint(1);
    if (!coordinator) return;
    // A sleeping device does not lose its reporting configuration to a power
    // cycle, because it has no power cycle to lose it to.
    if (!isMainsPowered(device) || !isInterviewed(device)) return;

    const epoch = this.#epoch;

    for (const endpoint of device.endpoints) {
      if (endpoint.getInputClusters().length === 0) continue;

      const key = stateKey(device.ieeeAddr, endpoint.ID);
      const outcome = await configureReporting(endpoint, coordinator, this.log);
      if (this.#shuttingDown || this.#epoch !== epoch) return;

      if (outcome.configured.length > 0) this.#armed.add(key);
      else this.#armed.delete(key);

      await this.#accessories.get(this.api.hap.uuid.generate(key))?.refreshFromRadio();
      if (this.#shuttingDown || this.#epoch !== epoch) return;
    }
  }

  // --------------------------------------------------------------- refresh

  #startRefreshTimer(): void {
    if (this.#refreshTimer) return;

    const timer = setInterval(() => {
      // A cycle that has not finished is a cycle whose reads are still queued
      // behind a device that is not answering. Starting a second one behind it
      // only makes the queue longer.
      if (this.#refreshing) {
        this.log.debug("The previous refresh cycle is still running; skipping this one.");
        return;
      }

      this.#refreshing = this.#refreshAll()
        .catch((error: unknown) => {
          this.log.warn(`Refresh cycle failed: ${describe(error)}`);
        })
        .finally(() => {
          this.#refreshing = undefined;
        });
    }, this.config.refreshInterval * 1_000);
    timer.unref?.();
    this.#refreshTimer = timer;
  }

  /**
   * Re-read mains-powered devices.
   *
   * A safety net for lights whose reporting configuration did not take, not the
   * primary path. Battery devices are deliberately excluded: they are asleep,
   * so polling them fails and costs battery on the way.
   */
  async #refreshAll(): Promise<void> {
    const controller = this.#controller;
    if (!controller || this.#shuttingDown) return;

    const epoch = this.#epoch;

    for (const accessory of this.#accessories.values()) {
      if (!accessory.mainsPowered) continue;
      await accessory.refreshFromRadio();
      if (this.#shuttingDown || this.#epoch !== epoch || this.#controller !== controller) return;
    }
  }

  async #stop(): Promise<void> {
    this.#shuttingDown = true;

    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;

    // Both check `#shuttingDown` after every await, so this is a short wait for
    // the request already on the radio — not for the whole pass. Disposing the
    // accessories underneath a running pass is what it avoids.
    await Promise.allSettled([this.#discovering, this.#refreshing, ...this.#rearming.values()]);

    for (const accessory of this.#accessories.values()) accessory.dispose();
    this.#accessories.clear();

    await this.#supervisor?.stop();
    this.#controller = undefined;
  }
}
