// Telling "this is really gone" apart from a temporary failure, so a daemon
// restart never makes a healthy thread look deleted.

/** bb reports a missing thread or environment as "HTTP 404: ... not found". */
export function isNotFound(error: unknown): boolean {
  return /\b404\b|not[ _]found/iu.test(String(error));
}

/** Runs a lookup: null when the thing doesn't exist, and any other failure still throws. */
export async function orNullIfGone<T>(lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
