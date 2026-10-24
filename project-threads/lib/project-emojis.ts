/**
 * Parses the "Project emojis" setting: one `Project name: emoji` per line.
 * Names match case-insensitively; blank or malformed lines are skipped.
 */
export function parseProjectEmojis(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    // Split on the last colon so project names may contain one.
    const at = line.lastIndexOf(":");
    if (at === -1) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const emoji = line.slice(at + 1).trim();
    if (name !== "" && emoji !== "") map.set(name, emoji);
  }
  return map;
}

/** `name` prefixed with its emoji, if one is set. */
export function withEmoji(emojis: ReadonlyMap<string, string>, name: string): string {
  const emoji = emojis.get(name.trim().toLowerCase());
  return emoji === undefined ? name : `${emoji} ${name}`;
}
