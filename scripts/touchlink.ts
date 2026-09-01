/**
 * Factory reset a nearby light over the air, then pair it.
 *
 * Touchlink is the only way to reset a Hue device without its own bridge, and
 * it is deliberately short range — the device must be within a metre or so of
 * the coordinator's antenna. It needs an adapter that implements InterPAN,
 * which `ember` does and `zoh` does not.
 *
 * Homebridge must be stopped: a coordinator can only be held open by one
 * process.
 *
 *   ZIGBEE_PORT=/dev/serial/by-id/usb-... ZIGBEE_ADAPTER=ember pnpm touchlink
 *
 * With no argument it scans and lists what answers, changing nothing. Pass an
 * IEEE address to reset that device, or `--first` to reset the only one found.
 */
import { resolve } from "node:path";
import { Controller } from "zigbee-herdsman";

import { parseConfig } from "#config";
import { loadOrCreateIdentity } from "#zigbee/identity";

const port = process.env["ZIGBEE_PORT"];
if (!port) {
  console.error("Missing ZIGBEE_PORT. See the comment at the top of scripts/touchlink.ts.");
  process.exit(1);
}

const target = process.argv[2];

const config = parseConfig({
  platform: "Zigbee",
  port,
  adapter: process.env["ZIGBEE_ADAPTER"] ?? "ember",
  channel: Number(process.env["ZIGBEE_CHANNEL"] ?? 25),
});

const stateDirectory = resolve(process.env["ZIGBEE_STATE_DIR"] ?? ".zigbee");
const identity = loadOrCreateIdentity(resolve(stateDirectory, "identity.json"));

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
  adapter: { disableLED: false, concurrent: 1 },
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

const result = await controller.start();
console.log(`Coordinator ${result} the network on channel ${config.channel}.\n`);

console.log("Scanning for Touchlink devices (hold them close to the antenna)...");
const found = await controller.touchlink.scan();

if (found.length === 0) {
  console.log("Nothing answered. Touchlink range is very short — move the device closer.");
  await controller.stop();
  process.exit(1);
}

for (const device of found) {
  console.log(`  ${device.ieeeAddr}  on channel ${device.channel}`);
}

if (!target) {
  console.log("\nRe-run with an IEEE address (or --first) to factory reset one of these.");
  await controller.stop();
  process.exit(0);
}

const chosen =
  target === "--first"
    ? found[0]
    : found.find((d) => d.ieeeAddr.toLowerCase() === target.toLowerCase());

if (!chosen) {
  console.error(`\n${target} did not answer the scan.`);
  await controller.stop();
  process.exit(1);
}

console.log(`\nFactory resetting ${chosen.ieeeAddr} — it should flash a few times.`);
const reset = await controller.touchlink.factoryReset(chosen.ieeeAddr, chosen.channel);
console.log(reset ? "Reset accepted." : "Reset was NOT accepted.");

if (reset) {
  const seconds = 180;
  await controller.permitJoin(seconds);
  console.log(`\nPairing open for ${seconds}s; the device should rejoin on its own.`);
  await new Promise<void>((done) => {
    const timer = setTimeout(done, seconds * 1_000);
    process.on("SIGINT", () => {
      clearTimeout(timer);
      done();
    });
  });
  await controller.permitJoin(0);
  console.log("\nPairing closed.");
}

await controller.stop();
