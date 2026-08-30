import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Both of these must stay external, for different reasons.
  //
  // `homebridge` is supplied by the host at runtime and is only ever imported
  // for its types. It is deliberately not a peer dependency — npm refuses to
  // resolve `^2.0.0` against a prerelease like 2.3.0-beta.1, which blocks
  // installs on Homebridge betas.
  //
  // `zigbee-herdsman` is CommonJS and reaches a native N-API addon
  // (@serialport/bindings-cpp) through its own SerialPort wrapper. Bundling it
  // would detach the JS from the .node binary it resolves relative to itself.
  deps: { neverBundle: ["homebridge", "zigbee-herdsman"] },
  target: "node22",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
});
