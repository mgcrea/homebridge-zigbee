/**
 * Open the network for pairing, from the command line.
 *
 * The plugin also exposes a pairing switch in the Home app, which is usually
 * more convenient. This exists for the case where Homebridge is stopped, or
 * where you want to watch the interview happen.
 *
 * Homebridge must be stopped: a Zigbee coordinator can only be held open by one
 * process.
 *
 *   ZIGBEE_PORT=/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_...-if00 pnpm pair 120
 *
 * A Hue bulb already paired to a Hue bridge will not join until it is factory
 * reset. Delete it in the Hue app (on a bridge, that is a factory reset), or
 * power cycle it with the timing the bulb actually counts: starting from on,
 * off for 2s and on for 8s, five times over. A quick flick does nothing.
 *
 * A Hue Dimmer Switch held next to the bulb works too, via Touchlink between
 * those two — this plugin's own stack implements no Touchlink, so it cannot
 * reset a bulb for you.
 */
import { resolve } from "node:path";
import { Controller } from "zigbee-herdsman";

import { parseConfig } from "#config";
import { loadOrCreateIdentity, writeStackConfig } from "#zigbee/identity";

const port = process.env["ZIGBEE_PORT"];
if (!port) {
  console.error("Missing ZIGBEE_PORT. See the comment at the top of scripts/pair.ts.");
  process.exit(1);
}

const seconds = Math.min(254, Math.max(30, Number(process.argv[2] ?? 120)));

const config = parseConfig({
  platform: "Zigbee",
  port,
  adapter: process.env["ZIGBEE_ADAPTER"] ?? "zoh",
  channel: Number(process.env["ZIGBEE_CHANNEL"] ?? 15),
});

const stateDirectory = resolve(process.env["ZIGBEE_STATE_DIR"] ?? ".zigbee");
const identity = loadOrCreateIdentity(resolve(stateDirectory, "identity.json"));
writeStackConfig(stateDirectory, identity);

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

controller.on("deviceJoined", ({ device }) => {
  console.log(`joined:     ${device.ieeeAddr}`);
});
controller.on("deviceInterview", ({ status, device }) => {
  console.log(`interview:  ${device.ieeeAddr} ${status}`);
  if (status === "successful") {
    console.log(`            ${device.manufacturerName ?? "?"} ${device.modelID ?? "?"}`);
  }
});
controller.on("deviceAnnounce", ({ device }) => {
  console.log(`announce:   ${device.ieeeAddr}`);
});

const result = await controller.start();
console.log(`Coordinator ${result} the network on channel ${config.channel}.`);

await controller.permitJoin(seconds);
console.log(`Pairing is open for ${seconds}s. Put the device into pairing mode now.\n`);

await new Promise<void>((done) => {
  const timer = setTimeout(done, seconds * 1_000);
  process.on("SIGINT", () => {
    clearTimeout(timer);
    done();
  });
});

await controller.permitJoin(0);
console.log("\nPairing closed.");
await controller.stop();
