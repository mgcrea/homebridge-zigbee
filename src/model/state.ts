/**
 * The single place a device's last-known attribute values live.
 *
 * Everything that arrives from the radio — attribute reports the device pushed,
 * read responses the plugin asked for — lands here, and accessories read from
 * here rather than holding their own copies. That keeps a bulb's state in one
 * place no matter which of the several paths delivered it.
 *
 * Values are stored as `unknown` and narrowed on the way out. The alternative
 * is trusting whatever a device put on the wire to match its own advertised
 * type, which is exactly the assumption that produces a temperature of `"on"`.
 */

/** `${ieeeAddr}/${endpointId}` — a HomeKit service maps to one of these. */
export type StateKey = string;

export const stateKey = (ieeeAddr: string, endpointId: number): StateKey =>
  `${ieeeAddr}/${endpointId}`;

export type StateChange = {
  key: StateKey;
  cluster: string;
  /** Only the attributes whose value actually differs from the stored one. */
  changed: ReadonlyMap<string, unknown>;
};

type Listener = (change: StateChange) => void;

export class StateStore {
  readonly #values = new Map<StateKey, Map<string, Map<string, unknown>>>();
  readonly #listeners = new Map<StateKey, Set<Listener>>();
  /**
   * When each endpoint was last heard from at all.
   *
   * Deliberately separate from the values. A light that faithfully reports the
   * same brightness every minute changes nothing, so tracking liveness by
   * "when did a value last move" would call a perfectly healthy device stale.
   */
  readonly #lastHeard = new Map<StateKey, number>();

  /**
   * Merge an attribute payload in, and tell subscribers what actually moved.
   *
   * Reports that repeat a value already held are dropped rather than forwarded.
   * A mains-powered bulb re-reports on a timer whether or not anything changed,
   * and passing those through would push a HomeKit update per report.
   */
  apply(key: StateKey, cluster: string, attributes: Readonly<Record<string, unknown>>): boolean {
    // Before anything else: we heard from it, whatever it said.
    this.#lastHeard.set(key, Date.now());

    let clusters = this.#values.get(key);
    if (!clusters) {
      clusters = new Map();
      this.#values.set(key, clusters);
    }

    let stored = clusters.get(cluster);
    if (!stored) {
      stored = new Map();
      clusters.set(cluster, stored);
    }

    const changed = new Map<string, unknown>();
    for (const [attribute, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      if (stored.get(attribute) === value) continue;
      stored.set(attribute, value);
      changed.set(attribute, value);
    }

    if (changed.size === 0) return false;

    for (const listener of this.#listeners.get(key) ?? []) {
      listener({ key, cluster, changed });
    }
    return true;
  }

  /** Whether anything at all has been heard from this endpoint yet. */
  isKnown(key: StateKey): boolean {
    return this.#values.has(key);
  }

  /** When anything was last heard from this endpoint, or undefined if never. */
  heardAt(key: StateKey): number | undefined {
    return this.#lastHeard.get(key);
  }

  /** How long since anything was heard from this endpoint, or undefined if never. */
  ageMs(key: StateKey, now: number = Date.now()): number | undefined {
    const heard = this.#lastHeard.get(key);
    return heard === undefined ? undefined : now - heard;
  }

  read(key: StateKey, cluster: string, attribute: string): unknown {
    return this.#values.get(key)?.get(cluster)?.get(attribute);
  }

  readNumber(key: StateKey, cluster: string, attribute: string): number | undefined {
    const value = this.read(key, cluster, attribute);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  /**
   * A boolean attribute, accepting the numeric form too.
   *
   * `genOnOff.onOff` is a ZCL boolean, which some stacks surface as `true` and
   * others as `1`. Both mean the light is on.
   */
  readBoolean(key: StateKey, cluster: string, attribute: string): boolean | undefined {
    const value = this.read(key, cluster, attribute);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return undefined;
  }

  subscribe(key: StateKey, listener: Listener): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(key);
    };
  }

  forget(key: StateKey): void {
    this.#values.delete(key);
    this.#listeners.delete(key);
    this.#lastHeard.delete(key);
  }

  clear(): void {
    this.#values.clear();
    this.#listeners.clear();
    this.#lastHeard.clear();
  }
}
