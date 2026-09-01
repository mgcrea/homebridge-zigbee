/**
 * Drive a paired light directly, to prove the command path before Homebridge is
 * anywhere near it.
 *
 * Deliberately goes through the plugin's own conversion helpers rather than
 * hand-rolled numbers, so a clean run here is evidence about `#util/color` and
 * the exact command shapes `LightAccessory` sends — not just evidence that the
 * radio works.
 *
 * Homebridge must be stopped: a coordinator can only be held open by one
 * process.
 *
 *   ZIGBEE_PORT=/dev/serial/by-id/usb-... pnpm control 0x001788010cb878e9
 */
import { resolve } from "node:path";
import { Controller } from "zigbee-herdsman";

import { parseConfig } from "#config";
import { CLUSTER } from "#model/capability";
import {
  hueSatToXy,
  levelToPercent,
  percentToLevel,
  xyToAttributes,
  xyToHueSat,
  attributesToXy,
} from "#util/color";
import { loadOrCreateIdentity, writeStackConfig } from "#zigbee/identity";

const port = process.env["ZIGBEE_PORT"];
if (!port) {
  console.error("Missing ZIGBEE_PORT.");
  process.exit(1);
}

const target = process.argv[2]?.toLowerCase();
if (!target) {
  console.error("Usage: pnpm control 0x<ieee>");
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

const pause = async (ms: number): Promise<void> => {
  await new Promise((done) => setTimeout(done, ms));
};

await controller.start();

const device = controller.getDeviceByIeeeAddr(target);
if (!device) {
  console.error(`No device ${target}. Run \`pnpm diagnose\` to list what is paired.`);
  await controller.stop();
  process.exit(1);
}

const endpoint = device.endpoints.find((candidate) => candidate.getInputClusters().length > 0);
if (!endpoint) {
  console.error(`${target} has no controllable endpoint.`);
  await controller.stop();
  process.exit(1);
}

const transition = Math.round(config.transitionTime * 10);
let failures = 0;

const step = async (label: string, run: () => Promise<void>): Promise<void> => {
  process.stdout.write(`  ${label.padEnd(34)}`);
  try {
    await run();
    console.log("ok");
  } catch (error) {
    failures += 1;
    console.log(`FAILED — ${error instanceof Error ? error.message : String(error)}`);
  }
  await pause(1_800);
};

console.log(
  `\n${device.manufacturerName ?? "?"} ${device.modelID ?? "?"} on endpoint ${endpoint.ID}`,
);
console.log("Watch the lamp.\n");

await step("identify (blink 3s)", async () => {
  await endpoint.command("genIdentify", "identify", { identifytime: 3 });
});
await pause(2_000);

await step("off", async () => {
  await endpoint.command("genOnOff", "off", {});
});
await step("on", async () => {
  await endpoint.command("genOnOff", "on", {});
});
await step("brightness 10%", async () => {
  await endpoint.command("genLevelCtrl", "moveToLevelWithOnOff", {
    level: percentToLevel(10),
    transtime: transition,
  });
});
await step("brightness 100%", async () => {
  await endpoint.command("genLevelCtrl", "moveToLevelWithOnOff", {
    level: percentToLevel(100),
    transtime: transition,
  });
});
await step("warm white (450 mired)", async () => {
  await endpoint.command("lightingColorCtrl", "moveToColorTemp", {
    colortemp: 450,
    transtime: transition,
  });
});
await step("cool white (200 mired)", async () => {
  await endpoint.command("lightingColorCtrl", "moveToColorTemp", {
    colortemp: 200,
    transtime: transition,
  });
});

for (const [name, hue] of [
  ["red", 0],
  ["green", 120],
  ["blue", 240],
] as const) {
  await step(`colour ${name} (hue ${hue})`, async () => {
    const xy = hueSatToXy({ hue, saturation: 100 });
    await endpoint.command("lightingColorCtrl", "moveToColor", {
      ...xyToAttributes(xy),
      transtime: transition,
    });
  });
}

console.log("\nReading state back:");
try {
  const onOff = await endpoint.read("genOnOff", ["onOff"]);
  const level = await endpoint.read("genLevelCtrl", ["currentLevel"]);
  const colour = await endpoint.read("lightingColorCtrl", [
    "colorTemperature",
    "currentX",
    "currentY",
  ]);

  console.log(`  ${CLUSTER.onOff}.onOff          = ${String(onOff["onOff"])}`);
  const raw = level["currentLevel"];
  console.log(
    `  ${CLUSTER.level}.currentLevel  = ${String(raw)}` +
      (typeof raw === "number" ? `  -> ${levelToPercent(raw)}% in HomeKit` : ""),
  );
  console.log(`  ${CLUSTER.color}.colorTemperature = ${String(colour["colorTemperature"])} mired`);

  const x = colour["currentX"];
  const y = colour["currentY"];
  if (typeof x === "number" && typeof y === "number") {
    const { hue, saturation } = xyToHueSat(attributesToXy(x, y));
    console.log(
      `  ${CLUSTER.color}.currentX/Y      = ${x}/${y}  -> hue ${hue}, sat ${saturation}%`,
    );
  }
} catch (error) {
  failures += 1;
  console.log(`  read FAILED — ${error instanceof Error ? error.message : String(error)}`);
}

await step("back to warm white, 100%", async () => {
  await endpoint.command("lightingColorCtrl", "moveToColorTemp", {
    colortemp: 370,
    transtime: transition,
  });
});

console.log(failures === 0 ? "\nAll steps succeeded.\n" : `\n${failures} step(s) failed.\n`);
await controller.stop();
process.exit(failures === 0 ? 0 : 1);
