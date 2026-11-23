import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions, SessionTable } from "../../../core/analysis/types";
import type { ScanResult } from "../../../core/scan";

/** The session table of a synthetic scan, at its own `finishedAt`, in `timeZone` (default UTC), under `exclude`. */
export const tableOf = (raw: ScanResult, exclude?: Exclusions, timeZone = "UTC"): SessionTable =>
  buildSessionTable(raw, { now: raw.finishedAt, timeZone, ...(exclude ? { exclude } : {}) });
