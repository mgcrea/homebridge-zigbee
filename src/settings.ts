import { createRequire } from "node:module";

/** Must match the `platform` key used in Homebridge's config.json. */
export const PLATFORM_NAME = "Zigbee";
/** Must match the package name exactly. */
export const PLUGIN_NAME = "@mgcrea/homebridge-zigbee";

/**
 * The plugin's own version, for accessories whose device will not tell us its
 * firmware.
 *
 * hap warns on every start about an AccessoryInformation service with no
 * FirmwareRevision, and a great many Zigbee devices simply do not implement
 * `softwareBuildID`. Reporting the plugin version there is what Homebridge's
 * own accessory helpers do, and it is at least true of the thing answering.
 *
 * Resolved through `createRequire` rather than an import assertion so that the
 * bundle keeps working: `package.json` sits one level above both `src/` in the
 * repository and `dist/` in the published tarball.
 */
export const PLUGIN_VERSION = ((): string => {
  try {
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json") as { version?: unknown };
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
