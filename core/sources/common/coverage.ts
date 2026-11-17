import { readdirSync } from "node:fs";
import { readJsonSmallResult, safeStat } from "../../io/fs";
import type { ToolId, Window } from "../../model/ids";
import type { PluginCoverage } from "../types";
import { isObj, type Obj } from "./guards";

const TYPE_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const SIDECAR_MAX = 8 * 1024 * 1024;

/** A string shaped like a schema type name (lower-case token), the shape drift keys keep verbatim. */
export const isTypeName = (s: string): boolean => TYPE_NAME.test(s);

/** A record or payload type as a drift key: the name when it looks like a schema token, else `(other)` / `(none)`. */
export const typeKey = (type: unknown): string => (typeof type !== "string" ? "(none)" : isTypeName(type) ? type : "(other)");

/** Coverage counters for one candidate of one source; `coverage()` builds the source's single CoverageEv. */
export class Tally {
  files = 0;
  bytes = 0;
  records = 0;
  readonly skipped: Record<string, number> = {};
  readonly unknownTypes: Record<string, number> = {};
  readonly versions = new Set<string>();
  from?: number;
  to?: number;
  note?: string;

  constructor(readonly tool: ToolId, readonly source: string, readonly window: Window = "detail") {}

  skip(reason: string): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  /** Unknown record types keep their name only when it looks like a schema token. */
  unknown(type: unknown): void {
    this.unknownKey(typeKey(type));
  }

  /** A pre-shaped drift key (e.g. `turnOrigin:<value>`, `event_msg:<type>`). */
  unknownKey(key: string): void {
    this.unknownTypes[key] = (this.unknownTypes[key] ?? 0) + 1;
  }

  span(ts: number): void {
    if (this.from === undefined || ts < this.from) this.from = ts;
    if (this.to === undefined || ts > this.to) this.to = ts;
  }

  /** The coverage of what was counted; `beta` is the plugin's, stamped by the orchestrator. */
  coverage(retentionDays?: number): PluginCoverage {
    const drift = Object.keys(this.unknownTypes).length > 0;
    const ev: PluginCoverage = {
      k: "coverage", tool: this.tool, source: this.source, window: this.window,
      status: drift ? "drift" : this.records === 0 ? "empty" : "ok",
      files: this.files, bytes: this.bytes, records: this.records, skipped: this.skipped, unknownTypes: this.unknownTypes,
      versions: [...this.versions].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    };
    if (retentionDays !== undefined) ev.retentionDays = retentionDays;
    if (this.from !== undefined) ev.from = this.from;
    if (this.to !== undefined) ev.to = this.to;
    if (this.note !== undefined) ev.note = this.note;
    return ev;
  }
}

/** Sorted entry names of a folder; a missing folder is empty, any other failure counts as io-error. */
export function listDir(dir: string, tally: Tally): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") tally.skip("io-error");
    return [];
  }
}

/**
 * A small JSON object file (metadata, summaries, settings, caches), counted toward coverage when it parses;
 * failures are counted by kind, while a missing path or a non-regular file is simply absent.
 */
export function readSidecar(file: string, tally: Tally): Obj | undefined {
  const r = readJsonSmallResult(file, SIDECAR_MAX);
  if (!r.ok) {
    if (r.reason !== "missing" && r.reason !== "not-file") tally.skip(r.reason);
    return undefined;
  }
  if (!isObj(r.value)) {
    tally.skip("parse");
    return undefined;
  }
  tally.files++;
  tally.bytes += safeStat(file)?.size ?? 0;
  return r.value;
}
