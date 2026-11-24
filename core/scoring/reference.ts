import V0 from "./reference/v0.json" with { type: "json" };
import type { Transform } from "./transform";

/**
 * One component's reference on the transformed, oriented scale (spec §6.5 Reference table v0): μ = p50 and
 * σ = (p90 − p50)/1.2816, with the written rationale for both anchors.
 */
export interface ReferenceEntry { p50: number; p90: number; transform: Transform; rationale: string }
export interface ReferenceTable { version: "v0"; components: Record<string, ReferenceEntry> }

/** The z of the 90th percentile: the reference's σ is (p90 − p50) / Z90. */
export const Z90 = 1.2816;

const deepFreeze = <T>(v: T): T => {
  if (v !== null && typeof v === "object") { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
};

// A JSON import, so a compiled binary carries the table (P3 pre-flight F17); frozen, since every caller shares it.
const TABLES: Readonly<Record<ReferenceTable["version"], ReferenceTable>> = { v0: deepFreeze(V0 as ReferenceTable) };

/** The pinned reference table (v0 is the only one); an unknown version is a RangeError. */
export function loadReference(v: ReferenceTable["version"] = "v0"): ReferenceTable {
  if (!Object.hasOwn(TABLES, v)) throw new RangeError("loadReference: unknown reference table (the only one is v0)");
  return TABLES[v];
}
