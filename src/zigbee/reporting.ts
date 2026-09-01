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
 * Bind a cluster, then run its reporting setup.
 *
 * Failures are logged and shrugged off on purpose. A light that refuses
 * reporting still works through commands and the periodic refresh — degrading
 * to "polled" is much better than refusing to expose the device at all.
 */
const bindThen = async (
  endpoint: Models.Endpoint,
  coordinator: Models.Endpoint,
  log: Logging,
  cluster: string,
  configure: () => Promise<void>,
): Promise<void> => {
  if (!endpoint.supportsInputCluster(cluster)) return;

  try {
    await endpoint.bind(cluster, coordinator);
  } catch (error) {
    log.debug(`Could not bind ${cluster} on ${endpoint.deviceIeeeAddress}: ${describe(error)}`);
    // Reporting without a binding goes nowhere, so skip configuring it.
    return;
  }

  try {
    await configure();
  } catch (error) {
    log.debug(
      `${endpoint.deviceIeeeAddress} refused reporting for ${cluster}: ${describe(error)}. ` +
        "Falling back to periodic reads for this device.",
    );
  }
};

export const configureReporting = async (
  endpoint: Models.Endpoint,
  coordinator: Models.Endpoint,
  log: Logging,
): Promise<void> => {
  await bindThen(endpoint, coordinator, log, CLUSTER.onOff, async () => {
    await endpoint.configureReporting("genOnOff", [
      { attribute: "onOff", ...INTERVALS, reportableChange: 0 },
    ]);
  });

  await bindThen(endpoint, coordinator, log, CLUSTER.level, async () => {
    await endpoint.configureReporting("genLevelCtrl", [
      { attribute: "currentLevel", ...INTERVALS, reportableChange: 1 },
    ]);
  });

  await bindThen(endpoint, coordinator, log, CLUSTER.color, async () => {
    await endpoint.configureReporting("lightingColorCtrl", [
      { attribute: "colorTemperature", ...INTERVALS, reportableChange: 1 },
      // Without this, a colourTemperature report cannot be told apart from the
      // stale value a light in xy mode reports for the same attribute.
      { attribute: "colorMode", ...INTERVALS, reportableChange: 0 },
      // xy is uint16, so a change of 256 is roughly 0.4% of the axis — enough
      // to notice a real colour change without reporting on sensor noise.
      { attribute: "currentX", ...INTERVALS, reportableChange: 256 },
      { attribute: "currentY", ...INTERVALS, reportableChange: 256 },
    ]);
  });
};

/**
 * Re-read a device's state.
 *
 * Only ever called for mains-powered devices. A battery device is asleep almost
 * all the time; polling it would not get an answer, and would shorten its
 * battery life while failing.
 */
export const refresh = async (endpoint: Models.Endpoint, log: Logging): Promise<void> => {
  const attempt = async (cluster: string, read: () => Promise<unknown>): Promise<void> => {
    if (!endpoint.supportsInputCluster(cluster)) return;
    try {
      await read();
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
};

/** Mains-powered devices are the only ones safe to poll. */
export const isMainsPowered = (device: Models.Device): boolean =>
  device.powerSource === "Mains (single phase)" || device.powerSource === "DC Source";
