/**
 * Exponential backoff with jitter, for the coordinator reconnect loop.
 *
 * The jitter matters more than the growth does: without it, a Homebridge that
 * restarts on a schedule alongside whatever knocked the adapter out will retry
 * in lockstep with it forever.
 */
export type Backoff = {
  /** How long to wait before the next attempt, in milliseconds. */
  next: () => number;
  /** Called once a connection succeeds. */
  reset: () => void;
  readonly attempts: number;
};

export const createBackoff = ({
  initial = 2_000,
  max = 60_000,
  factor = 2,
}: { initial?: number; max?: number; factor?: number } = {}): Backoff => {
  let attempts = 0;

  return {
    next: () => {
      const delay = Math.min(max, initial * factor ** attempts);
      attempts += 1;
      // Equal jitter: anywhere in [delay/2, delay]. Deliberately not full
      // jitter — a retry that can land arbitrarily close to zero is no gentler
      // on a coordinator that has just refused to open than no backoff at all.
      return Math.round(delay / 2 + Math.random() * (delay / 2));
    },
    reset: () => {
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
  };
};
