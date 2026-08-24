/** Parse a dotted triple (`1.2.3`). Returns null when the string is not that shape. */
export const parseDotVersion = (raw: string): [number, number, number] | null => {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (matched === null) return null;
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
};

/** True when `a` is strictly greater than `b` in major/minor/patch order. */
export const isStrictlyGreater = (a: readonly [number, number, number], b: readonly [number, number, number]): boolean => {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
};

/** `0.0.20` → `0.0.21`. Null when `raw` is not a dotted triple. */
export const bumpPatchVersion = (raw: string): string | null => {
  const parts = parseDotVersion(raw);
  if (parts === null) return null;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
};

export type ManifestBump = {
  /** The version the manifest carried. */
  from: string;
  /** The version the returned source carries. */
  to: string;
  /** `source` with the version line rewritten and every other byte preserved. */
  source: string;
};

/**
 * A `"version"` key indented like a top-level manifest key. Anchored and bounded
 * so a `"version"` nested inside some future object literal does not match: the
 * count of matches is what makes the rewrite safe, and an unanchored pattern
 * would quietly find two.
 */
const VERSION_LINE = /^[ \t]{1,4}"version"[ \t]*:[ \t]*"([^"]*)"/gm;

/**
 * Advance the patch version inside a `package.json` **source string**, rewriting
 * only the version line.
 *
 * Parse-mutate-stringify is the obvious implementation and the wrong one: this
 * manifest keeps `dependencies` and `engines` on single lines, and
 * `JSON.stringify` would expand them, turning a one-line release commit into a
 * whole-file reformat.
 *
 * Two independent checks agree before anything is written — exactly one line
 * looks like the top-level version, and that line's value is what `JSON.parse`
 * reports as `version`. Either alone could be satisfied by the wrong key; both
 * together cannot. Anything ambiguous throws rather than guessing, because the
 * caller pushes the result straight to `main`.
 */
export const bumpManifestSource = (source: string): ManifestBump => {
  const matches = [...source.matchAll(VERSION_LINE)];
  if (matches.length === 0) {
    throw new Error('package.json has no top-level "version" line to bump');
  }
  if (matches.length > 1) {
    throw new Error(
      `package.json has ${matches.length} candidate "version" lines; cannot tell which one is the package version`
    );
  }

  const match = matches[0] as RegExpExecArray;
  const from = match[1] as string;
  const declared = (JSON.parse(source) as { version?: unknown }).version;
  if (declared !== from) {
    throw new Error(
      `package.json version line says ${JSON.stringify(from)} but JSON.parse reports ${JSON.stringify(declared)}`
    );
  }

  const to = bumpPatchVersion(from);
  if (to === null) {
    throw new Error(`package.json version ${JSON.stringify(from)} is not a dotted triple; cannot bump it`);
  }

  // Postcondition, not decoration. This value becomes a published release
  // number the moment the caller commits it, so the one property that must hold
  // — it advanced — is checked rather than assumed.
  const fromParts = parseDotVersion(from) as [number, number, number];
  const toParts = parseDotVersion(to) as [number, number, number];
  if (!isStrictlyGreater(toParts, fromParts)) {
    throw new Error(`bumped version ${to} is not strictly greater than ${from}`);
  }

  const start = match.index as number;
  const rewritten = match[0].replace(`"${from}"`, `"${to}"`);
  return { from, to, source: `${source.slice(0, start)}${rewritten}${source.slice(start + match[0].length)}` };
};
