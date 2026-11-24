import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import { projectLabels } from "../../../core/analysis/labels";
import type { Ev } from "../../../core/model/events";
import { keyedHash } from "../../../core/text/hash";
import { scanResultOf } from "../../kit/scanresult";

const SALT = new Uint8Array(32).fill(7);
const T0 = Date.UTC(2026, 10, 2, 9, 0);

/** Two keys whose labels agree on their first `len` hex digits (and so on every shorter prefix). */
function collidingPair(len: number): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; ; i++) {
    const k = `key-${i}`;
    const h = keyedHash(SALT, `label:${k}`).slice(0, len);
    const was = seen.get(h);
    if (was !== undefined) return [was, k];
    seen.set(h, k);
  }
}

describe("project labels are unique", () => {
  test("a 4-hex collision resolves at 6; the other keys keep 4", () => {
    const [a, b] = collidingPair(4);
    const labels = projectLabels(SALT, [a, b, "other"]);
    expect(labels.get(a)).toMatch(/^P-[0-9A-F]{6}$/);
    expect(labels.get(b)).toMatch(/^P-[0-9A-F]{6}$/);
    expect(labels.get(a)).not.toBe(labels.get(b));
    expect(labels.get("other")).toMatch(/^P-[0-9A-F]{4}$/);
  });

  test("a 6-hex collision resolves at 8", () => {
    const [a, b] = collidingPair(6);
    const labels = projectLabels(SALT, [a, b]);
    expect(labels.get(a)).toMatch(/^P-[0-9A-F]{8}$/);
    expect(labels.get(b)).toMatch(/^P-[0-9A-F]{8}$/);
    expect(labels.get(a)).not.toBe(labels.get(b));
    expect(labels.get(a)).toBe(`P-${keyedHash(SALT, `label:${a}`, 8).toUpperCase()}`);
  });

  test("two keys that still collide at 16 digits are a thrown error", () => {
    expect(() => projectLabels(SALT, ["x", "y"], () => "0123456789abcdef0123")).toThrow(RangeError);
  });

  test("excluding one of two colliding projects by its label removes exactly that project", () => {
    const [a, b] = collidingPair(6);
    const evs: Ev[] = [a, b].flatMap((key, i): Ev[] => [
      { k: "session", tool: "claude-code", source: "claude-code.transcripts", id: `s${i}`, window: "detail", origin: "human", start: T0, end: T0 + 60_000, models: [], projectKey: key },
    ]);
    const all = analyze(scanResultOf(evs, { salt: SALT }), { timeZone: "UTC" });
    const la = all.projects.find((p) => p.key === a)!.label;
    const out = analyze(scanResultOf(evs, { salt: SALT }), { timeZone: "UTC", exclude: { projects: [la] } });
    expect(out.projects.map((p) => p.key)).toEqual([b]);
    expect(out.exclusions.sessions).toBe(1);
  });
});
