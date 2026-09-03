/** A short, log-friendly rendering of anything thrown. */
export const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const ZCL_COMMAND = /ZCL command \S+ ([\w.]+)\(/;
const TIMED_OUT = /timed out after (\d+)\s*ms/;
const ZCL_STATUS = /[Ss]tatus[ =:]+'?([A-Z_]{3,})'?/;

/**
 * The same, for a command that the radio refused or never got an answer to.
 *
 * herdsman renders a failed ZCL command as the entire request — the cluster,
 * the command, every option it was sent with, and the raw APS frame beneath
 * it. That is around four hundred characters of which one clause matters, and
 * it lands in the user's log as a wall of JSON every time a lamp is switched
 * off at the wall. Only the parts a person can act on survive here; the full
 * text is still available at debug level wherever it is caught.
 */
export const describeCommandFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);

  const command = ZCL_COMMAND.exec(message)?.[1];
  if (!command) return describe(error);

  const timeout = TIMED_OUT.exec(message)?.[1];
  if (timeout !== undefined) {
    return `${command} got no answer within ${Math.round(Number(timeout) / 1000)}s`;
  }

  const status = ZCL_STATUS.exec(message)?.[1];
  return status === undefined ? `${command} failed` : `${command} was refused (${status})`;
};
