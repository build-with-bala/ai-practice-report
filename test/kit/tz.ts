/**
 * Runs `f` with `process.env.TZ = tz`, then restores the zone by assignment: TZ's previous value, or — when it was unset —
 * the zone that was in effect (`bun test` runs in UTC with TZ unset; assigning "" would switch to the system zone instead).
 * Never `delete process.env.TZ`: in Bun 1.3 that removes the variable's setter, so the zone stays at its last value and
 * later assignments are ignored for the rest of the process, every later test file included.
 */
export function withTz<T>(tz: string, f: () => T): T {
  const saved = process.env.TZ ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = tz;
    return f();
  } finally {
    process.env.TZ = saved;
  }
}
