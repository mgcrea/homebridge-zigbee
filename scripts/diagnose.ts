/**
 * What the plugin would see, without a bridge in the way.
 *
 * The first thing to reach for when something misbehaves: it prints the IEEE
 * addresses to put in per-device settings, every endpoint's clusters, and the
 * capabilities the plugin derives from them — so a light exposed as the wrong
 * kind of accessory can be traced back to the cluster that decided it.
 *
 * Homebridge must be stopped first: a Zigbee coordinator can only be held open
 * by one process.
 *
 *   ZIGBEE_PORT=/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_...-if00 pnpm diagnose
 */
import { resolve } from "node:path";
import { Controller } from "zigbee-herdsman";

import { parseConfig } from "#config";
import { loadOrCreateIdentity, writeStackConfig } from "#zigbee/identity";
import { capabilitiesFrom, CLUSTER, colorSupportFrom } from "#model/capability";

const port = process.env["ZIGBEE_PORT"];
if (!port) {
  console.error("Missing ZIGBEE_PORT.");
  console.error(
    "Set it to your coordinator, preferably its stable /dev/serial/by-id/ path:\n" +
      "  ZIGBEE_PORT=/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_XXXX-if00 pnpm diagnose",
  );
  process.exit(1);
}

const config = parseConfig({
  platform: "Zigbee",
  port,
  adapter: process.env["ZIGBEE_ADAPTER"] ?? "zoh",
  channel: Number(process.env["ZIGBEE_CHANNEL"] ?? 15),
});

const stateDirectory = resolve(process.env["ZIGBEE_STATE_DIR"] ?? ".zigbee");
const identity = loadOrCreateIdentity(resolve(stateDirectory, "identity.json"));
writeStackConfig(stateDirectory, identity);

console.log(`Opening ${config.port} (${config.adapter} @ ${config.baudRate})...`);

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
  databasePath: resolve(stateDirectory, "devices.db"),
  databaseBackupPath: resolve(stateDirectory, "devices.db.backup"),
  backupPath: resolve(stateDirectory, "backup.json"),
  adapter: { disableLED: false },
  acceptJoiningDeviceHandler: async () => await Promise.resolve(true),
});

const shutdown = async (): Promise<void> => {
  try {
    await controller.stop();
  } catch {
    // Already closing; nothing useful to add.
  }
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

const result = await controller.start();
console.log(`Coordinator ${result} the network on channel ${config.channel}.`);

const version = await controller.getCoordinatorVersion();
console.log(`Firmware: ${version.type} ${JSON.stringify(version.meta)}`);
console.log(`Coordinator IEEE: ${identity.eui64}`);
console.log(`PAN ID: 0x${identity.panId.toString(16)}\n`);

const devices = [...controller.getDevicesIterator((device) => device.type !== "Coordinator")];

if (devices.length === 0) {
  console.log("No devices are paired yet. Run `pnpm pair 120` and factory reset a device.");
} else {
  console.log(`${devices.length} device(s) paired:\n`);
}

for (const device of devices) {
  console.log(`${device.ieeeAddr}  ${device.manufacturerName ?? "?"} ${device.modelID ?? "?"}`);
  console.log(
    `  type=${device.type} power=${device.powerSource ?? "?"} ` +
      `firmware=${device.softwareBuildID ?? "?"} lastSeen=${
        device.lastSeen ? new Date(device.lastSeen).toISOString() : "never"
      }`,
  );

  for (const endpoint of device.endpoints) {
    const inputs = endpoint.getInputClusters().map((cluster) => cluster.name);
    if (inputs.length === 0) continue;

    let colorCapabilities: number | undefined;
    let hasBounds = false;
    if (endpoint.supportsInputCluster(CLUSTER.color)) {
      try {
        const read = await endpoint.read("lightingColorCtrl", [
          "colorCapabilities",
          "colorTempPhysicalMin",
          "colorTempPhysicalMax",
        ]);
        colorCapabilities =
          typeof read["colorCapabilities"] === "number" ? read["colorCapabilities"] : undefined;
        hasBounds =
          typeof read["colorTempPhysicalMin"] === "number" &&
          typeof read["colorTempPhysicalMax"] === "number";
        console.log(
          `  endpoint ${endpoint.ID} colourTemp range: ` +
            `${String(read["colorTempPhysicalMin"])}-${String(read["colorTempPhysicalMax"])} mireds`,
        );
      } catch {
        console.log(`  endpoint ${endpoint.ID} would not report its colour capabilities`);
      }
    }

    const color = endpoint.supportsInputCluster(CLUSTER.color)
      ? colorSupportFrom(colorCapabilities, hasBounds)
      : undefined;
    const capabilities = [...capabilitiesFrom(endpoint, color)];

    console.log(`  endpoint ${endpoint.ID} (deviceId 0x${(endpoint.deviceID ?? 0).toString(16)})`);
    console.log(`    in:  ${inputs.join(", ")}`);
    console.log(
      `    -> capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}`,
    );
  }
  console.log();
}

await shutdown();
