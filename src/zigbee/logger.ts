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
const UNACTIONABLE: readonly (readonly [key: string, pattern: RegExp, explanation: string])[] = [
  [
    "mac",
    /Unsupported MAC frame/i,
    "Ignoring frames this coordinator cannot decode. These are MAC-secured frames from another " +
      "network on the same channel — typically Thread. They are harmless; enable debug logging " +
      "to see them.",
  ],
];

/**
 * herdsman `info` lines that must not be swallowed.
 *
 * Everything herdsman logs at info goes to debug, because most of it is
 * per-frame bookkeeping. These two are not: they describe the coordinator
 * changing identity, which is the situation the reset guard exists for, and an
 * operator who cannot see them has no way of knowing why their devices went
 * quiet.
 */
const NOTEWORTHY = [/Coordinator address changed/i, /does not match adapter channel/i];

export const installHerdsmanLogger = (log: Logging, debug: boolean): void => {
  /**
   * Which demotions have been explained already, keyed per pattern.
   *
   * One key for the whole table meant the first pattern to fire silenced the
   * explanation for every later one, so a second kind of noise arrived with no
   * account of itself at all.
   */
  const explained = new Set<string>();

  const demote = (message: string): boolean => {
    const matched = UNACTIONABLE.find(([, pattern]) => pattern.test(message));
    if (!matched) return false;

    const [key, , explanation] = matched;
    // Only the first line: the stack trace points into zoh's internals and says
    // nothing about this network.
    const [summary = message] = message.split("\n");

    if (explained.has(key)) {
      log.debug(summary.trim());
    } else {
      explained.add(key);
      log.info(`${explanation} (${summary.trim()})`);
    }
    return true;
  };

  const logger: HerdsmanLogger = {
    debug: debug
      ? (message, namespace) => log.debug(`[${namespace}] ${resolve(message)}`)
      : () => undefined,
    info: (message, namespace) => {
      const text = resolve(message);
      if (NOTEWORTHY.some((pattern) => pattern.test(text))) {
        log.info(`[${namespace}] ${text}`);
        return;
      }
      log.debug(`[${namespace}] ${text}`);
    },
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
