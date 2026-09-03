import type { PlatformConfig } from "homebridge";
import type { AdapterTypes } from "zigbee-herdsman";
import { z } from "zod";

/**
 * The plugin's configuration.
 *
 * Two conventions carried from the other plugins in this family. Required
 * fields that are missing throw, with a sentence a person can act on. Numeric
 * fields are **clamped rather than rejected**: an over-eager transition time is
 * a mistake worth correcting silently, not a reason to refuse to start.
 */

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Below this the mesh spends more time reporting than relaying. */
const MIN_REFRESH_S = 30;
const MAX_REFRESH_S = 3_600;
const DEFAULT_REFRESH_S = 300;

/** A HomeKit slider drag should not outlast the drag. */
const MIN_TRANSITION_S = 0;
const MAX_TRANSITION_S = 10;
const DEFAULT_TRANSITION_S = 0.4;

const MIN_PERMIT_JOIN_S = 30;
const MAX_PERMIT_JOIN_S = 254;
const DEFAULT_PERMIT_JOIN_S = 120;

/** 802.15.4 channels available in the 2.4GHz band. */
const MIN_CHANNEL = 11;
const MAX_CHANNEL = 26;
export const DEFAULT_CHANNEL = 15;

/**
 * The adapters zigbee-herdsman ships. Validated here so a typo produces a
 * sentence at startup rather than an obscure failure once the port is open.
 */
export const ADAPTERS = [
  "zoh",
  "ember",
  "ezsp",
  "zstack",
  "deconz",
  "zboss",
  "zigate",
] as const satisfies readonly AdapterTypes.Adapter[];

const zAdapter = z.enum(ADAPTERS);

const zPerDevice = z.looseObject({
  /** The device's IEEE address, as shown by `pnpm diagnose`. Matched case-insensitively. */
  ieee: z.string(),
  name: z.string().optional(),
  exclude: z.boolean().optional(),
});

const zConfig = z.looseObject({
  port: z.string().optional(),
  adapter: zAdapter.optional(),
  baudRate: z.number().optional(),
  rtscts: z.boolean().optional(),
  channel: z.number().optional(),

  adaptiveLighting: z.boolean().optional(),
  exposePairingSwitch: z.boolean().optional(),
  permitJoinDuration: z.number().optional(),
  refreshInterval: z.number().optional(),
  transitionTime: z.number().optional(),

  allowNetworkReset: z.boolean().optional(),
  debug: z.boolean().optional(),

  // Walked by hand rather than parsed as an array: the Config UI creates an
  // empty row the moment someone presses "Add", and a `z.array` parse fails on
  // the whole list because of it — which took the platform dormant and left
  // every light in the house unresponsive until the row was deleted by hand.
  devices: z.unknown().optional(),
});

export type DeviceOverride = {
  ieee: string;
  name: string | undefined;
  exclude: boolean;
};

export type ZigbeeConfig = {
  port: string;
  adapter: AdapterTypes.Adapter;
  /**
   * Left undefined unless set, so herdsman's per-adapter detection decides.
   *
   * `Adapter.create` fills both of these in from the detected stick when they
   * are absent — 38400 for a ConBee, 115200 for a Z-Stack, 460800 for a ZBT-2.
   * Defaulting them here to what a ZBT-2 wants silently broke every other
   * adapter the plugin claims to support.
   */
  baudRate: number | undefined;
  rtscts: boolean | undefined;
  channel: number;
  adaptiveLighting: boolean;
  exposePairingSwitch: boolean;
  permitJoinDuration: number;
  refreshInterval: number;
  /** Seconds, as HomeKit means it; converted to ZCL tenths at the command. */
  transitionTime: number;
  allowNetworkReset: boolean;
  debug: boolean;
  devices: DeviceOverride[];
};

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const clamped = (value: number | undefined, min: number, max: number, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : clamp(value, min, max);

/** IEEE addresses are compared lower-case and `0x`-prefixed throughout. */
export const normalizeIeee = (ieee: string): string => {
  const trimmed = ieee.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
};

/** Which field went wrong, not just what was wrong with it. */
const describeIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  const path = issue?.path.join(".");
  const message = issue?.message ?? "is not usable";
  return path ? `"${path}" ${message}` : message;
};

/**
 * Keep the per-device rows that are usable and say why the others went.
 *
 * One malformed row is not a reason to take the platform down. The port is —
 * without it there is nothing to open — but an unfinished override should cost
 * the user that override, not their lights.
 */
const parseDevices = (value: unknown, warn: (message: string) => void): DeviceOverride[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warn('Ignoring "devices": expected a list.');
    return [];
  }

  const kept: DeviceOverride[] = [];
  value.forEach((entry, index) => {
    const result = zPerDevice.safeParse(entry);
    if (!result.success) {
      warn(`Ignoring devices[${index}]: ${describeIssue(result.error)}.`);
      return;
    }
    kept.push({
      ieee: normalizeIeee(result.data.ieee),
      name: result.data.name?.trim() || undefined,
      exclude: result.data.exclude ?? false,
    });
  });
  return kept;
};

export const parseConfig = (
  raw: PlatformConfig,
  warn: (message: string) => void = () => undefined,
): ZigbeeConfig => {
  const parsed = zConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${describeIssue(parsed.error)}`);
  }
  const config = parsed.data;

  const port = config.port?.trim();
  if (!port) {
    throw new ConfigError(
      "No serial port configured. Set `port` to your coordinator, preferably by its stable " +
        "path under /dev/serial/by-id/ rather than /dev/ttyACM0, which renumbers across reboots.",
    );
  }

  return {
    port,
    adapter: config.adapter ?? "zoh",
    baudRate: config.baudRate,
    rtscts: config.rtscts,
    channel: clamped(config.channel, MIN_CHANNEL, MAX_CHANNEL, DEFAULT_CHANNEL),
    adaptiveLighting: config.adaptiveLighting ?? true,
    exposePairingSwitch: config.exposePairingSwitch ?? true,
    permitJoinDuration: clamped(
      config.permitJoinDuration,
      MIN_PERMIT_JOIN_S,
      MAX_PERMIT_JOIN_S,
      DEFAULT_PERMIT_JOIN_S,
    ),
    refreshInterval: clamped(
      config.refreshInterval,
      MIN_REFRESH_S,
      MAX_REFRESH_S,
      DEFAULT_REFRESH_S,
    ),
    transitionTime: clamped(
      config.transitionTime,
      MIN_TRANSITION_S,
      MAX_TRANSITION_S,
      DEFAULT_TRANSITION_S,
    ),
    allowNetworkReset: config.allowNetworkReset ?? false,
    debug: config.debug ?? false,
    devices: parseDevices(config.devices, warn),
  };
};

export const overrideFor = (config: ZigbeeConfig, ieee: string): DeviceOverride | undefined => {
  const wanted = normalizeIeee(ieee);
  return config.devices.find((device) => device.ieee === wanted);
};
