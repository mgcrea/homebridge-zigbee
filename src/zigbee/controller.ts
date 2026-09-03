/**
 * The coordinator's lifecycle: opening it, guarding what `start()` reports,
 * and getting back on the radio after it drops.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logging } from "homebridge";
import { Controller } from "zigbee-herdsman";

import type { ZigbeeConfig } from "#config";
import { createBackoff } from "#util/backoff";
import { describe } from "#util/describe";
import { loadOrCreateIdentity, type NetworkIdentity, writeStackConfig } from "#zigbee/identity";

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

/** herdsman's device database: one JSON object per line. */
const DATABASE_FILE = "devices.db";
/** Where herdsman copies the database to just before it clears it on a reset. */
const DATABASE_BACKUP_FILE = "devices.db.backup";
const BACKUP_FILE = "backup.json";
/** zoh's own network state: PAN ID, network key, trust centre key, counters. */
const ZOH_SAVE_FILE = "zoh.save";
/** Written when the guard refuses, so a restart cannot quietly proceed. */
const RESET_MARKER_FILE = "network-reset.json";

/**
 * Everything under here is a network credential or a record of one, so the
 * directory is the enforcement point: zoh writes `zoh.save` 0644 and there is
 * no hook to change that, but a 0700 directory keeps it out of reach anyway.
 */
const STATE_DIRECTORY_MODE = 0o700;

export type StartOutcome = {
  controller: Controller;
  result: "resumed" | "reset" | "restored";
  /**
   * How many devices were paired *before* `start()` ran.
   *
   * Counted from the database file rather than from the controller, because
   * herdsman clears the database inside `start()` on a reset — by the time
   * anything can ask the controller, the answer is always zero.
   */
  previouslyPaired: number;
};

/**
 * Count the devices herdsman's database holds, without opening it.
 *
 * The file is newline-delimited JSON, one object per entity, with `type`
 * distinguishing devices from groups. Anything unparseable is skipped for the
 * same reason herdsman skips it: a corrupted line is not a reason to refuse to
 * start, and undercounting here only ever makes the guard *less* likely to
 * fire, never more.
 */
export const countPairedDevices = (databasePath: string): number => {
  let raw: string;
  try {
    raw = readFileSync(databasePath, "utf8");
  } catch {
    return 0;
  }

  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown };
    } catch {
      continue;
    }
    if (typeof entry.type !== "string") continue;
    if (entry.type === "Coordinator" || entry.type === "Group") continue;
    count += 1;
  }
  return count;
};

/**
 * How many devices a reset here would orphan.
 *
 * The live database is the first answer. After a refusal it is empty — herdsman
 * clears it inside `start()` and copies the old one aside — so the backup is
 * what still describes the network the user actually has, and it is what keeps
 * the guard firing on every restart rather than only the first.
 */
const orphanCount = (paths: ControllerPaths): number => {
  const live = countPairedDevices(join(paths.stateDirectory, DATABASE_FILE));
  if (live > 0) return live;
  return countPairedDevices(join(paths.stateDirectory, DATABASE_BACKUP_FILE));
};

const markerPath = (paths: ControllerPaths): string =>
  join(paths.stateDirectory, RESET_MARKER_FILE);

const writeResetMarker = (paths: ControllerPaths, orphaned: number, log: Logging): void => {
  try {
    writeFileSync(
      markerPath(paths),
      `${JSON.stringify({ version: 1, refusedAt: new Date().toISOString(), orphaned }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    log.debug(`Could not record the network reset refusal: ${describe(error)}`);
  }
};

const clearResetMarker = (paths: ControllerPaths, log: Logging): void => {
  try {
    rmSync(markerPath(paths), { force: true });
  } catch (error) {
    log.debug(`Could not clear the network reset marker: ${describe(error)}`);
  }
};

/**
 * The sentence that follows every refusal, whichever side of `start()` caught it.
 */
const howToRecover = (paths: ControllerPaths): string =>
  "Restore this plugin's zigbee/ directory from a backup to get the old network back — " +
  `${join(paths.stateDirectory, ZOH_SAVE_FILE)} and ` +
  `${join(paths.stateDirectory, DATABASE_FILE)} are the two files that matter, and ` +
  `${join(paths.stateDirectory, DATABASE_BACKUP_FILE)} holds the device list as it was ` +
  "just before this happened.\n" +
  "If you genuinely want to start over and re-pair every device, set `allowNetworkReset` " +
  `to true; the plugin will then clear ${markerPath(paths)} and carry on.`;

/**
 * Refuse *before* the radio is touched, when the evidence is already in.
 *
 * Two things say a reset is coming. zoh decides "same network or new one" by
 * comparing the configured identity against `zoh.save`, so a missing save file
 * with devices still paired means the next `start()` will form a new network
 * and orphan every one of them. And a marker left by an earlier refusal means
 * this has already happened once and nothing has been restored since.
 *
 * Catching it here rather than after `start()` matters: by the time `start()`
 * returns "reset" the database has already been cleared and the devices are
 * already orphaned.
 */
export const assertSafeToStart = (
  config: ZigbeeConfig,
  paths: ControllerPaths,
  orphaned: number,
  log: Logging,
): void => {
  if (config.allowNetworkReset) {
    clearResetMarker(paths, log);
    return;
  }

  if (orphaned === 0) return;

  const refusedBefore = existsSync(markerPath(paths));
  const saveMissing =
    config.adapter === "zoh" && !existsSync(join(paths.stateDirectory, ZOH_SAVE_FILE));

  if (!refusedBefore && !saveMissing) return;

  const because = refusedBefore
    ? "The plugin already refused to start on a reset network and nothing has been restored since " +
      `(${markerPath(paths)}).`
    : `The adapter's saved network state is gone (${join(paths.stateDirectory, ZOH_SAVE_FILE)} ` +
      "does not exist), so the coordinator would form a NEW network on this start.";

  throw new NetworkResetError(
    `${because}\n` +
      `${orphaned} device(s) are paired to the previous network. Starting would orphan every ` +
      "one of them and fill the Home app with tiles backed by nothing, so the platform is " +
      "staying dormant and the radio has not been opened.\n" +
      howToRecover(paths),
  );
};

/**
 * Every setting herdsman's `Controller` is given, in one place.
 *
 * The scripts open the same radio as the plugin does, and each of them used to
 * spell this out again — which is how `concurrent: 1` came to be set in the
 * plugin and in `touchlink.ts` but nowhere else, leaving `diagnose` and
 * `control` running eight simultaneous transmissions on a coordinator that
 * wedges under exactly that.
 */
export const controllerOptions = (
  config: ZigbeeConfig,
  identity: NetworkIdentity,
  paths: ControllerPaths,
): ConstructorParameters<typeof Controller>[0] => ({
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
    // Left undefined unless configured, so herdsman's per-adapter detection
    // gets to pick — a ConBee wants 38400 and a Z-Stack stick 115200, and
    // forcing a ZBT-2's 460800 onto either of them just fails to open.
    ...(config.baudRate === undefined ? {} : { baudRate: config.baudRate }),
    ...(config.rtscts === undefined ? {} : { rtscts: config.rtscts }),
  },
  databasePath: join(paths.stateDirectory, DATABASE_FILE),
  databaseBackupPath: join(paths.stateDirectory, DATABASE_BACKUP_FILE),
  // zoh keeps its own state in `zoh.save` beside this file and never writes a
  // coordinator backup, but herdsman still requires the path.
  backupPath: join(paths.stateDirectory, BACKUP_FILE),
  adapter: {
    disableLED: false,
    // One radio request at a time. The default of 8 lets a burst of
    // characteristic writes put eight simultaneous transmissions on a single
    // radio, which is how an OT-RCP coordinator ends up wedged.
    concurrent: 1,
  },
  acceptJoiningDeviceHandler: async () => await Promise.resolve(true),
});

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
  mkdirSync(paths.stateDirectory, { recursive: true, mode: STATE_DIRECTORY_MODE });
  // `mkdirSync` honours `mode` only when it creates the directory, and umask
  // trims it even then, so tighten it unconditionally.
  chmodSync(paths.stateDirectory, STATE_DIRECTORY_MODE);

  const previouslyPaired = orphanCount(paths);
  assertSafeToStart(config, paths, previouslyPaired, log);

  const identity = loadOrCreateIdentity(join(paths.stateDirectory, "identity.json"));
  writeStackConfig(paths.stateDirectory, identity);

  const controller = new Controller(controllerOptions(config, identity, paths));

  let result: Awaited<ReturnType<Controller["start"]>>;
  try {
    result = await controller.start();
  } catch (error) {
    await closeController(controller, log, "failed-start");
    throw error;
  }

  const outcome: StartOutcome = { controller, result, previouslyPaired };

  try {
    assertNetworkIntact(outcome, config, paths);
  } catch (error) {
    if (error instanceof NetworkResetError) {
      // Record it, so a restart does not find a matching zoh.save, report
      // "resumed", and quietly hand the user an empty network.
      writeResetMarker(paths, previouslyPaired, log);
      await closeController(controller, log, "refused");
    }
    throw error;
  }

  log.info(`Coordinator ${result} the network on channel ${config.channel}.`);

  return outcome;
};

export type CloseMode =
  /** `start()` threw: the port may or may not have been opened. */
  | "failed-start"
  /** The reset guard said no to a controller that started perfectly well. */
  | "refused"
  /** Homebridge is going away. */
  | "shutdown"
  /** The adapter dropped and a fresh controller is about to take its place. */
  | "disconnected";

/**
 * Let go of the serial port, whatever state the controller is in.
 *
 * `start()` opens the port and *then* talks to the chip, so any failure past
 * that point — a Spinel timeout, an EZSP `HOST_FATAL_ERROR` — leaves the port
 * open inside a controller nobody holds a reference to. Every retry then fails
 * with "Cannot lock port" and the plugin has locked itself out of its own
 * radio until Homebridge is restarted by hand, which is precisely what the
 * retry loop exists to prevent.
 *
 * `stop()` alone does not fix it, for two separate reasons.
 *
 * When `adapter.start()` never succeeded, `adapterDisconnected` is still true
 * and `stop()` saves the database and returns without ever reaching
 * `adapter.stop()`. When it *did* succeed, `stop()` runs an unguarded
 * `backup()` before `adapter.stop()`, and `backup()` asks the adapter for a
 * network state it cannot produce — that exception escapes `stop()` before the
 * adapter is stopped. `backup()` skips the adapter entirely when `backupPath`
 * is unset, so clearing it lets `stop()` run to completion.
 *
 * And on zoh even `adapter.stop()` is not enough: it stops the driver and
 * leaves the file descriptor open. Only the public `closePort()` releases it.
 *
 * `options` and `adapter` are private to TypeScript, not at runtime, hence the
 * cast. It is a reach past the type and it is deliberately confined here.
 */
export const closeController = async (
  controller: Controller,
  log: Logging,
  mode: CloseMode,
): Promise<void> => {
  const internals = controller as unknown as {
    options?: { backupPath?: string | undefined };
    adapter?: { closePort?: () => Promise<void> };
    isAdapterDisconnected?: () => boolean;
  };
  const adapter = internals.adapter;

  if (mode === "failed-start" && !adapter) {
    // `Adapter.create()` itself threw, so no port was ever opened — and
    // `stop()` would throw a TypeError reaching for the adapter that is not
    // there. Nothing to release, and nothing worth alarming anyone about.
    log.debug("The coordinator failed before a port was opened; nothing to release.");
    return;
  }

  // `stop()` is a no-op for the port when the adapter never finished starting:
  // it saves the database and returns. Skip straight to the port.
  const stopIsUseless = mode === "failed-start" && internals.isAdapterDisconnected?.() === true;

  if (!stopIsUseless) {
    // Defuse the unguarded backup() inside stop(). The backup being skipped is
    // one that could not have been written anyway, since the adapter it would
    // have read from is the thing that just failed.
    if (mode === "failed-start" && internals.options) internals.options.backupPath = undefined;

    try {
      await controller.stop();
    } catch (error) {
      // Bookkeeping. The port is what matters, and that is handled below.
      log.debug(`Stopping the coordinator (${mode}): ${describe(error)}`);
    }
  }

  try {
    await adapter?.closePort?.();
  } catch (error) {
    // Now genuinely unrecoverable: the port stays locked until the process
    // restarts. Say so plainly rather than letting the retry loop spin
    // forever against a lock it can never win.
    log.error(
      `Could not release the serial port (${describe(error)}) — it may stay locked. ` +
        "If every retry now reports 'Cannot lock port', restart Homebridge: the port is held " +
        "by this process and only a restart will free it.",
    );
  }
};

/**
 * Refuse to carry on when the coordinator formed a *new* network while devices
 * were already paired to the old one.
 *
 * `"reset"` on a first run is entirely normal — there is no network yet. On a
 * run where devices were already paired it means the network identity and the
 * adapter's saved state have diverged, and every one of those devices has just
 * been orphaned. Registering accessories at that point would fill HomeKit with
 * tiles backed by nothing, so the platform stays dormant instead and says why.
 *
 * The count comes from `previouslyPaired`, read off the database file before
 * `new Controller`. Asking the controller would always answer zero: herdsman
 * clears the database inside `start()` on a reset, before anything else can
 * look.
 */
export const assertNetworkIntact = (
  outcome: Pick<StartOutcome, "result" | "previouslyPaired">,
  config: ZigbeeConfig,
  paths: ControllerPaths,
): void => {
  if (outcome.result !== "reset" || outcome.previouslyPaired === 0) return;
  if (config.allowNetworkReset) return;

  throw new NetworkResetError(
    `The coordinator formed a NEW Zigbee network, but ${outcome.previouslyPaired} device(s) ` +
      "were paired to the previous one. They are no longer reachable and would show as " +
      "unresponsive in the Home app.\n" +
      "This usually means the adapter's saved network state was lost or replaced.\n" +
      howToRecover(paths),
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
    /** Injected so the supervisor's retry contract can be tested without a radio. */
    private readonly open: typeof openController = openController,
  ) {}

  get controller(): Controller | undefined {
    return this.#controller;
  }

  /**
   * Open the coordinator, and keep trying if it is not ready yet.
   *
   * The first attempt failing is not a reason to give up for the lifetime of
   * the process. A USB coordinator is routinely unavailable for a moment —
   * after a container restart the previous process may not have released it,
   * and a ZBT-2's USB bridge needs a beat before it answers Spinel at all.
   * Observed as `SPINEL[tid=1] Timeout after 10000ms` on a fast restart, which
   * previously left the plugin dead until Homebridge itself was restarted.
   *
   * A refusal to proceed on a reset network is different: that is a deliberate
   * decision, not a transient fault, so it is re-thrown rather than retried.
   *
   * Opening and adopting are kept strictly apart from handing the controller to
   * the platform. A failure in `onReady` is a bug in the platform layer, not
   * evidence about the radio, and treating it as one used to close a perfectly
   * healthy controller and reopen it in a loop.
   */
  async start(): Promise<void> {
    let outcome: StartOutcome;
    try {
      outcome = await this.#open();
    } catch (error) {
      if (error instanceof NetworkResetError) throw error;

      this.log.error(`Could not open the Zigbee coordinator: ${describe(error)}`);
      this.log.info(
        `Check that ${this.config.port} exists and that nothing else has it open ` +
          "(zigbee2mqtt, ZHA and this plugin cannot share a radio). Retrying meanwhile.",
      );
      void this.#reconnect().catch((reason: unknown) => {
        this.log.error(`The coordinator retry loop stopped: ${describe(reason)}`);
      });
      return;
    }

    await this.#ready(outcome);
  }

  async #open(): Promise<StartOutcome> {
    const outcome = await this.open(this.config, this.paths, this.log);
    this.#adopt(outcome.controller);
    this.#backoff.reset();
    return outcome;
  }

  /** Hand the open controller to the platform; never let that reach the radio. */
  async #ready(outcome: StartOutcome): Promise<void> {
    try {
      await this.onReady(outcome.controller, outcome.result);
    } catch (error) {
      this.log.error(
        `The Zigbee platform could not set itself up on the open coordinator: ${describe(error)}. ` +
          "The radio is fine; this is a plugin fault and reopening it would not help.",
      );
    }
  }

  #adopt(controller: Controller): void {
    this.#controller = controller;
    controller.on("adapterDisconnected", () => {
      if (this.#stopping) return;
      this.log.warn("The Zigbee coordinator disconnected. Reopening it.");
      void this.#reconnect().catch((reason: unknown) => {
        this.log.error(`The coordinator retry loop stopped: ${describe(reason)}`);
      });
    });
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#stopping) return;
    this.#reconnecting = true;

    try {
      // Release the dead controller before opening another on the same port.
      await this.#closeCurrent("disconnected");

      while (!this.#stopping) {
        const delay = this.#backoff.next();
        this.log.info(`Retrying the coordinator in ${Math.round(delay / 1000)}s.`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        if (this.#stopping) return;

        let outcome: StartOutcome;
        try {
          outcome = await this.#open();
        } catch (error) {
          if (error instanceof NetworkResetError) {
            // Deliberate refusal: retrying cannot change the answer.
            this.log.error(error.message);
            return;
          }
          this.log.error(`Could not reopen the coordinator: ${describe(error)}`);
          continue;
        }

        await this.#ready(outcome);
        this.log.info("Coordinator reconnected.");
        return;
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  async #closeCurrent(mode: CloseMode): Promise<void> {
    const controller = this.#controller;
    this.#controller = undefined;
    if (!controller) return;

    await closeController(controller, this.log, mode);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#closeCurrent("shutdown");
  }
}
