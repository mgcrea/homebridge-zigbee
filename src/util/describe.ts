/** A short, log-friendly rendering of anything thrown. */
export const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
