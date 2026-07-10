/**
 * Shared helpers for reading provider CLI versions.
 *
 * Each provider CLI prints its version in a slightly different shape:
 *   codex-cli 0.144.1
 *   2.1.204 (Claude Code)
 *   1.17.15
 *   2026.06.26-7079533
 *
 * `parseCliVersion` extracts the first version-like token so the UI can show
 * exactly which build is installed instead of a bare installed/missing flag.
 */

// First dotted-number run. No leading \b so a "v"-prefixed version (v1.2.3) still
// keeps its major component; a preceding digit/dot is excluded so we start at the
// real major.
const VERSION_TOKEN = /(?<![\d.])(\d+\.\d+[A-Za-z0-9.+_-]*)/;

export function parseCliVersion(output: string | null | undefined): string | null {
  if (!output) {
    return null;
  }
  const match = String(output).match(VERSION_TOKEN);
  return match?.[1] ?? null;
}
