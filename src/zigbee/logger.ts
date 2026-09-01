/**
 * Bridge zigbee-herdsman's logger onto Homebridge's.
 *
 * herdsman logs a great deal at debug level — every frame, in both directions —
 * so that level is gated behind the plugin's own `debug` flag rather than
 * Homebridge's, which people leave on for unrelated reasons.
 *
 * Its `debug` argument is a thunk: the message is only built if it will be
 * used, which is the difference between a quiet bridge and one spending real
 * time formatting strings it throws away.
 */
import type { Logging } from "homebridge";
import { setLogger } from "zigbee-herdsman";

type HerdsmanLogger = {
  debug: (message: string | (() => string), namespace: string) => void;
  info: (message: string | (() => string), namespace: string) => void;
  warning: (message: string | (() => string), namespace: string) => void;
  error: (message: string | (() => string), namespace: string) => void;
};

const resolve = (message: string | (() => string)): string =>
  typeof message === "function" ? message() : message;

/**
 * Noise the stack reports as an error that no operator can act on.
 *
 * `Unsupported MAC frame: security enabled` is zigbee-on-host meeting a frame
 * secured at the MAC layer. Zigbee secures at the network layer, so these are
 * someone else's traffic — in practice a Thread network sharing the channel,
 * since Thread is MAC-secured. Nothing is wrong and nothing can be fixed, but
 * zoh raises it at error level with a full stack trace, once per frame. Left
 * alone it buries real errors in the Homebridge log.
 */
const UNACTIONABLE = [/Unsupported MAC frame/i];

const isUnactionable = (message: string): boolean =>
  UNACTIONABLE.some((pattern) => pattern.test(message));

export const installHerdsmanLogger = (log: Logging, debug: boolean): void => {
  /** Explain the demoted noise once, so it is discoverable but not repeated. */
  const explained = new Set<string>();

  const demote = (message: string): boolean => {
    if (!isUnactionable(message)) return false;

    // Only the first line: the stack trace points into zoh's internals and says
    // nothing about this network.
    const [summary = message] = message.split("\n");
    if (!explained.has("mac")) {
      explained.add("mac");
      log.info(
        `Ignoring frames this coordinator cannot decode (${summary.trim()}). These are ` +
          "MAC-secured frames from another network on the same channel — typically Thread. " +
          "They are harmless; enable debug logging to see them.",
      );
    } else {
      log.debug(summary.trim());
    }
    return true;
  };

  const logger: HerdsmanLogger = {
    debug: debug
      ? (message, namespace) => log.debug(`[${namespace}] ${resolve(message)}`)
      : () => undefined,
    info: (message, namespace) => log.debug(`[${namespace}] ${resolve(message)}`),
    warning: (message, namespace) => {
      const text = resolve(message);
      if (demote(text)) return;
      log.warn(`[${namespace}] ${text}`);
    },
    error: (message, namespace) => {
      const text = resolve(message);
      if (demote(text)) return;
      log.error(`[${namespace}] ${text}`);
    },
  };

  setLogger(logger);
};
