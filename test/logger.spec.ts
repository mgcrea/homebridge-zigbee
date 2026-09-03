/**
 * The logger bridge exists to keep zigbee-on-host's idea of "error" from
 * becoming Homebridge's. The case that matters is a frame the stack cannot
 * decode: unactionable, and emitted once per frame with a full stack trace.
 */
import type { Logging } from "homebridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

type HerdsmanLoggerLike = {
  debug: (message: string | (() => string), namespace: string) => void;
  info: (message: string | (() => string), namespace: string) => void;
  warning: (message: string | (() => string), namespace: string) => void;
  error: (message: string, namespace: string) => void;
};

/** Hoisted so the module factory below can reach it. */
const holder = vi.hoisted(() => ({ logger: undefined as unknown }));

vi.mock("zigbee-herdsman", () => ({
  setLogger: (logger: unknown) => {
    holder.logger = logger;
  },
}));

const { installHerdsmanLogger } = await import("#zigbee/logger");

const MAC_NOISE =
  "Error: Unsupported MAC frame: security enabled\n" +
  "    at decodeMACPayload (/x/zigbee-on-host/src/zigbee/mac.ts:1120:15)\n" +
  "    at processFrame (/x/zigbee-on-host/src/zigbee-stack/frame.ts:53:40)";

type Captured = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

let log: Captured;

const install = (): HerdsmanLoggerLike => {
  installHerdsmanLogger(log as unknown as Logging, false);
  if (!holder.logger) throw new Error("setLogger was not called");
  return holder.logger as HerdsmanLoggerLike;
};

beforeEach(() => {
  holder.logger = undefined;
  log = {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    debug: vi.fn<(message: string) => void>(),
  };
});

describe("unactionable radio noise", () => {
  it("never reaches Homebridge as an error", () => {
    install().error(MAC_NOISE, "ot-rcp-driver");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("is explained once, then goes quiet", () => {
    const logger = install();
    for (let i = 0; i < 5; i += 1) logger.error(MAC_NOISE, "ot-rcp-driver");

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(String(log.info.mock.calls[0]?.[0])).toMatch(/Thread/);
    // The remaining four are demoted rather than dropped entirely.
    expect(log.debug).toHaveBeenCalledTimes(4);
  });

  it("drops the stack trace, which points into the library's internals", () => {
    install().error(MAC_NOISE, "ot-rcp-driver");
    const emitted = String(log.info.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("at decodeMACPayload");
  });
});

describe("real problems", () => {
  it("still surface as errors", () => {
    install().error("Failed to open serial port", "zoh");
    expect(log.error).toHaveBeenCalledWith("[zoh] Failed to open serial port");
  });

  it("still surface as warnings", () => {
    install().warning("Device did not respond", "controller");
    expect(log.warn).toHaveBeenCalledWith("[controller] Device did not respond");
  });
});

describe("herdsman's info level", () => {
  /**
   * Almost everything herdsman logs at info is per-frame bookkeeping, so the
   * whole level goes to debug. These two lines are not bookkeeping: they
   * describe the coordinator changing identity, which is the situation the
   * reset guard exists for. Swallowing them left an operator with no account
   * of why every device had gone quiet.
   */
  it("keeps a coordinator address change visible", () => {
    install().info("Coordinator address changed, updating to '0x00124b0029ab1234'", "zh:c");

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("address changed"));
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("keeps a channel mismatch visible", () => {
    install().info(
      "Configured channel '15' does not match adapter channel '25', changing channel",
      "zh:c",
    );

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("does not match"));
  });

  it("still demotes the rest of it", () => {
    install().info("Received Zdo response", "zh:controller");

    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });
});
