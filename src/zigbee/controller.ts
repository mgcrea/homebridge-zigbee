/**
 * The coordinator's lifecycle: opening it, guarding what `start()` reports,
 * and getting back on the radio after it drops.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logging } from "homebridge";
import { Controller, type Models } from "zigbee-herdsman";

import type { ZigbeeConfig } from "#config";
import { createBackoff } from "#util/backoff";
import { describe } from "#util/describe";
import { loadOrCreateIdentity, writeStackConfig } from "#zigbee/identity";

export class NetworkResetError extends Error {
  override readonly name = "NetworkResetError";
}

export type ControllerPaths = {
  /** Directory holding the device database, zoh.save and zoh_config.json. */
  stateDirectory: string;
};

export const resolvePaths = (persistPath: string): ControllerPaths => ({
  stateDirectory: join(persistPath, "zigbee"),
});

export type StartOutcome = {
  controller: Controller;
  result: "resumed" | "reset" | "restored";
};

/**
 * Build the controller and open the radio.
 *
 * The network identity is loaded (or generated once) before the controller is
 * constructed, because herdsman hands those exact bytes to the adapter, and the
 * adapter compares them against its own saved copy to decide whether this is
 * the same network it had last time.
 */
export const openController = async (
  config: ZigbeeConfig,
  paths: ControllerPaths,
  log: Logging,
): Promise<StartOutcome> => {
  mkdirSync(paths.stateDirectory, { recursive: true });

  const identity = loadOrCreateIdentity(join(paths.stateDirectory, "identity.json"));
  writeStackConfig(paths.stateDirectory, identity);

  const controller = new Controller({
    network: {
      panID: identity.panId,
      extendedPanID: identity.extendedPanId,
      networkKey: identity.networkKey,
      channelList: [config.channel],
      networkKeyDistribute: false,
    },
    serialPort: {
      path: config.port,
      adapter: config.adapter,
      baudRate: config.baudRate,
      rtscts: config.rtscts,
    },
    databasePath: join(paths.stateDirectory, "devices.db"),
    databaseBackupPath: join(paths.stateDirectory, "devices.db.backup"),
    // zoh keeps its own state in `zoh.save` beside this file and never writes a
    // coordinator backup, but herdsman still requires the path.
    backupPath: join(paths.stateDirectory, "backup.json"),
    adapter: { disableLED: false },
    acceptJoiningDeviceHandler: async () => await Promise.resolve(true),
  });

  const result = await controller.start();
  log.info(`Coordinator ${result} the network on channel ${config.channel}.`);

  return { controller, result };
};

/**
 * Refuse to carry on when the coordinator formed a *new* network while devices
 * were already paired to the old one.
 *
 * `"reset"` on a first run is entirely normal — there is no network yet. On a
 * run where the database already holds devices it means the network identity
 * and the adapter's saved state have diverged, and every one of those devices
 * has just been orphaned. Registering accessories at that point would fill
 * HomeKit with tiles backed by nothing, so the platform stays dormant instead
 * and says why.
 */
export const assertNetworkIntact = (
  outcome: StartOutcome,
  config: ZigbeeConfig,
  knownDeviceCount: number,
): void => {
  if (outcome.result !== "reset" || knownDeviceCount === 0) return;

  if (config.allowNetworkReset) {
    return;
  }

  throw new NetworkResetError(
    `The coordinator formed a NEW Zigbee network, but ${knownDeviceCount} device(s) were paired ` +
      "to the previous one. They are no longer reachable and would show as unresponsive in the " +
      "Home app.\n" +
      "This usually means the adapter's saved network state was lost or replaced. Restore the " +
      "plugin's zigbee/ directory from a backup to get the old network back. If you genuinely " +
      "want to start over and re-pair every device, set `allowNetworkReset` to true.",
  );
};

/**
 * Keep the controller open, reopening it when the adapter drops.
 *
 * herdsman emits `adapterDisconnected` and then does nothing further, so
 * recovery is the caller's job. Each attempt builds a fresh controller: the old
 * one holds a serial port that is already gone.
 */
export class ControllerSupervisor {
  #controller: Controller | undefined;
  #stopping = false;
  #reconnecting = false;
  readonly #backoff = createBackoff();

  constructor(
    private readonly config: ZigbeeConfig,
    private readonly paths: ControllerPaths,
    private readonly log: Logging,
    private readonly onReady: (
      controller: Controller,
      result: StartOutcome["result"],
    ) => Promise<void>,
  ) {}

  get controller(): Controller | undefined {
    return this.#controller;
  }

  async start(): Promise<void> {
    const outcome = await openController(this.config, this.paths, this.log);
    this.#adopt(outcome.controller);
    this.#backoff.reset();
    await this.onReady(outcome.controller, outcome.result);
  }

  #adopt(controller: Controller): void {
    this.#controller = controller;
    controller.on("adapterDisconnected", () => {
      if (this.#stopping) return;
      this.log.warn("The Zigbee coordinator disconnected. Reopening it.");
      void this.#reconnect();
    });
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#stopping) return;
    this.#reconnecting = true;

    try {
      // Release the dead controller before opening another on the same port.
      await this.#closeCurrent();

      while (!this.#stopping) {
        const delay = this.#backoff.next();
        this.log.info(`Retrying the coordinator in ${Math.round(delay / 1000)}s.`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        if (this.#stopping) return;

        try {
          const outcome = await openController(this.config, this.paths, this.log);
          this.#adopt(outcome.controller);
          this.#backoff.reset();
          await this.onReady(outcome.controller, outcome.result);
          this.log.info("Coordinator reconnected.");
          return;
        } catch (error) {
          this.log.error(`Could not reopen the coordinator: ${describe(error)}`);
        }
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  async #closeCurrent(): Promise<void> {
    const controller = this.#controller;
    this.#controller = undefined;
    if (!controller) return;

    try {
      await controller.stop();
    } catch (error) {
      // The adapter is already gone; this is bookkeeping, not a failure.
      this.log.debug(`Closing the previous controller: ${describe(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#closeCurrent();
  }
}

/** Every endpoint of every paired device, coordinator excluded. */
export const pairedDevices = (controller: Controller): Models.Device[] => [
  ...controller.getDevicesIterator((device) => device.type !== "Coordinator"),
];
