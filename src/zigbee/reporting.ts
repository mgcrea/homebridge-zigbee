/**
 * Attribute reporting: asking a light to volunteer its state.
 *
 * Without this the plugin only knows what it set itself, so a bulb switched at
 * the wall, from a Hue app, or by a scene on another controller would show the
 * wrong state in the Home app until something happened to re-read it.
 *
 * Two things make this less tidy than it sounds. Reporting has to be *bound* to
 * the coordinator first, or the reports have nowhere to go. And Hue bulbs are
 * known to drop their reporting configuration across a power cycle, which is
 * why this is re-run on every `deviceAnnounce` rather than only at pairing.
 *
 * Each cluster is handled by name rather than through a loop over a table.
 * herdsman keys its ZCL types on the *literal* cluster name, so a loop widens
 * the key to `string` and gives up every attribute-name check with it — which
 * is precisely the checking worth having here.
 */
import type { Logging } from "homebridge";
import type { Models } from "zigbee-herdsman";

import { CLUSTER } from "#model/capability";
import { describe } from "#util/describe";

/** Report no more often than this, however fast the value moves. */
const MIN_INTERVAL_S = 1;
/**
 * Report at least this often even when nothing changes.
 *
 * Doubles as a liveness signal: a mains-powered light that has said nothing for
 * appreciably longer than this is not merely idle.
 */
const MAX_INTERVAL_S = 3_600;

const INTERVALS = {
  minimumReportInterval: MIN_INTERVAL_S,
  maximumReportInterval: MAX_INTERVAL_S,
} as const;

/**
 * Bind a cluster so its reports have somewhere to go.
 *
 * Returns whether the binding took. Reporting without one goes nowhere, so
 * there is no point configuring it if this fails.
 */
const bind = async (
  endpoint: Models.Endpoint,
  coordinator: Models.Endpoint,
  log: Logging,
  cluster: string,
): Promise<boolean> => {
  if (!endpoint.supportsInputCluster(cluster)) return false;

  try {
    await endpoint.bind(cluster, coordinator);
    return true;
  } catch (error) {
    log.debug(`Could not bind ${cluster} on ${endpoint.deviceIeeeAddress}: ${describe(error)}`);
    return false;
  }
};

/**
 * Configure one attribute, and report whether it took.
 *
 * One attribute per call, deliberately. A single `configureReporting` carrying
 * several attributes is one command: a device that refuses any one record
 * fails the whole thing, and the attributes it would happily have reported are
 * lost with it. Observed on a Hue Play, which accepted onOff and currentLevel
 * but silently ended up with no colour reporting at all.
 *
 * A failure is logged and shrugged off. A light that refuses reporting still
 * works through commands and the periodic refresh; degrading to "polled" beats
 * refusing to expose the device.
 */
const report = async (log: Logging, what: string, run: () => Promise<void>): Promise<boolean> => {
  try {
    await run();
    return true;
  } catch (error) {
    log.debug(`Reporting refused for ${what}: ${describe(error)}`);
    return false;
  }
};

/** What a `configureReporting` pass managed to arrange. */
export type ReportingOutcome = {
  configured: readonly string[];
  refused: readonly string[];
};

export const configureReporting = async (
  endpoint: Models.Endpoint,
  coordinator: Models.Endpoint,
  log: Logging,
): Promise<ReportingOutcome> => {
  const configured: string[] = [];
  const refused: string[] = [];
  const note = (name: string, ok: boolean): void => {
    (ok ? configured : refused).push(name);
  };

  if (await bind(endpoint, coordinator, log, CLUSTER.onOff)) {
    note(
      "onOff",
      // Discrete types (BOOLEAN here) take no reportableChange: the ZCL has no
      // notion of "changed by more than N" for a value that only has states.
      await report(log, "genOnOff.onOff", async () => {
        await endpoint.configureReporting("genOnOff", [{ attribute: "onOff", ...INTERVALS }]);
      }),
    );
  }

  if (await bind(endpoint, coordinator, log, CLUSTER.level)) {
    note(
      "currentLevel",
      await report(log, "genLevelCtrl.currentLevel", async () => {
        await endpoint.configureReporting("genLevelCtrl", [
          { attribute: "currentLevel", ...INTERVALS, reportableChange: 1 },
        ]);
      }),
    );
  }

  if (await bind(endpoint, coordinator, log, CLUSTER.color)) {
    note(
      "colorTemperature",
      await report(log, "lightingColorCtrl.colorTemperature", async () => {
        await endpoint.configureReporting("lightingColorCtrl", [
          { attribute: "colorTemperature", ...INTERVALS, reportableChange: 1 },
        ]);
      }),
    );

    note(
      "colorMode",
      // ENUM8 — discrete, so no reportableChange. Sending one is what made the
      // whole colour-cluster request fail before.
      await report(log, "lightingColorCtrl.colorMode", async () => {
        await endpoint.configureReporting("lightingColorCtrl", [
          { attribute: "colorMode", ...INTERVALS },
        ]);
      }),
    );

    for (const axis of ["currentX", "currentY"] as const) {
      note(
        axis,
        await report(log, `lightingColorCtrl.${axis}`, async () => {
          await endpoint.configureReporting("lightingColorCtrl", [
            // uint16, so 256 is roughly 0.4% of the axis — enough to catch a
            // real colour change without reporting on sensor noise.
            { attribute: axis, ...INTERVALS, reportableChange: 256 },
          ]);
        }),
      );
    }
  }

  if (refused.length > 0) {
    log.info(
      `${endpoint.deviceIeeeAddress}: reporting on ${configured.join(", ") || "nothing"}; ` +
        `refused for ${refused.join(", ")}. Those fall back to the periodic refresh.`,
    );
  } else {
    log.debug(`${endpoint.deviceIeeeAddress}: reporting on ${configured.join(", ")}.`);
  }

  return { configured, refused };
};

/**
 * Re-read a device's state.
 *
 * Only ever called for mains-powered devices. A battery device is asleep almost
 * all the time; polling it would not get an answer, and would shorten its
 * battery life while failing.
 */
export const refresh = async (endpoint: Models.Endpoint, log: Logging): Promise<boolean> => {
  let reached = false;
  let attempted = false;

  const attempt = async (cluster: string, read: () => Promise<unknown>): Promise<void> => {
    if (!endpoint.supportsInputCluster(cluster)) return;
    attempted = true;
    try {
      await read();
      reached = true;
    } catch (error) {
      log.debug(
        `Refresh of ${cluster} on ${endpoint.deviceIeeeAddress} failed: ${describe(error)}`,
      );
    }
  };

  await attempt(CLUSTER.onOff, async () => await endpoint.read("genOnOff", ["onOff"]));
  await attempt(CLUSTER.level, async () => await endpoint.read("genLevelCtrl", ["currentLevel"]));
  await attempt(
    CLUSTER.color,
    async () =>
      await endpoint.read("lightingColorCtrl", [
        "colorMode",
        "colorTemperature",
        "currentX",
        "currentY",
      ]),
  );

  // Nothing to read is not a failure to reach the device.
  return attempted ? reached : true;
};

/** Mains-powered devices are the only ones safe to poll. */
export const isMainsPowered = (device: Models.Device): boolean =>
  device.powerSource === "Mains (single phase)" || device.powerSource === "DC Source";
