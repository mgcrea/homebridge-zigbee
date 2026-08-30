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

export const installHerdsmanLogger = (log: Logging, debug: boolean): void => {
  const logger: HerdsmanLogger = {
    debug: debug
      ? (message, namespace) => log.debug(`[${namespace}] ${resolve(message)}`)
      : () => undefined,
    info: (message, namespace) => log.debug(`[${namespace}] ${resolve(message)}`),
    warning: (message, namespace) => log.warn(`[${namespace}] ${resolve(message)}`),
    error: (message, namespace) => log.error(`[${namespace}] ${resolve(message)}`),
  };

  setLogger(logger);
};
