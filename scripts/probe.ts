// Structure-only probe for trace stores. Prints shapes (keys, types, counts, field numbers) and NEVER values.
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { b64ToBytes, pbTryNested, type PbField } from "../core/io/protobuf";
import { readJsonl } from "../core/io/jsonl";
import { openRo } from "../core/io/sqlite";
import { TempRegistry } from "../core/io/temp";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const TYPE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,40}$/;
const TYPE_FIELDS = ["type", "kind", "record_type"] as const;
const MAX_DEPTH = 8;
const MAX_ARRAY_ELEMS = 20;
const MAX_PATHS = 400;
const MAX_TYPES = 50;
const MAX_CLASSES = 8;
const MAX_JSON_BYTES = 256 * 1024 * 1024;

function bucket(n: number): string {
  return n <= 10 ? "len≤10" : n <= 100 ? "len≤100" : n <= 1000 ? "len≤1k" : "len>1k";
}

function classOf(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `string(${bucket(v.length)})`;
  if (typeof v === "number" || typeof v === "bigint") return "number";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return `array(${v.length})`;
  return "object";
}

type Shape = Map<string, Map<string, number>>; // path -> class -> count

function note(shape: Shape, p: string, cls: string): void {
  let m = shape.get(p);
  if (!m) {
    if (shape.size >= MAX_PATHS) return;
    m = new Map();
    shape.set(p, m);
  }
  if (m.has(cls) || m.size < MAX_CLASSES) m.set(cls, (m.get(cls) ?? 0) + 1);
  else m.set("+more", (m.get("+more") ?? 0) + 1);
}

function walk(v: unknown, p: string, shape: Shape, depth: number): void {
  note(shape, p, classOf(v));
  if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const el of v.slice(0, MAX_ARRAY_ELEMS)) walk(el, p + "[]", shape, depth + 1);
    return;
  }
  const obj = v as Record<string, unknown>;
  let hidden = 0;
  const hiddenVals: unknown[] = [];
  for (const k of Object.keys(obj)) {
    if (KEY_RE.test(k)) walk(obj[k], `${p}.${k}`, shape, depth + 1);
    else {
      hidden++;
      if (hiddenVals.length < MAX_ARRAY_ELEMS) hiddenVals.push(obj[k]);
    }
  }
  if (hidden > 0) for (const hv of hiddenVals) walk(hv, `${p}.<k×${hidden}>`, shape, depth + 1);
}

function renderShape(shape: Shape, indent = "  "): string[] {
  return [...shape.keys()].sort().map((p) => {
    const m = shape.get(p)!;
    const classes = [...m.keys()].sort().map((c) => `${c}×${m.get(c)}`);
    return `${indent}${p}: ${classes.join(" | ")}`;
  });
}

export async function probeJsonl(path: string, maxLines = 5000): Promise<string> {
  const types = new Map<string, number>();
  const shapes = new Map<string, Shape>();
  let seen = 0;
  let records = 0;
  const skips: Record<string, number> = {};
  for await (const item of readJsonl(path)) {
    if (seen >= maxLines) break;
    seen++;
    if ("skip" in item) {
      skips[item.skip] = (skips[item.skip] ?? 0) + 1;
      continue;
    }
    records++;
    const v = item.value;
    let label = "(none)";
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const f of TYPE_FIELDS) {
        if (f in o) {
          const tv = o[f];
          label = typeof tv === "string" && TYPE_RE.test(tv) ? `${f}=${tv}` : `${f}=<other>`;
          break;
        }
      }
    } else label = `(${classOf(v)})`;
    if (!types.has(label) && types.size >= MAX_TYPES) label = "(more types)";
    types.set(label, (types.get(label) ?? 0) + 1);
    let shape = shapes.get(label);
    if (!shape) shapes.set(label, (shape = new Map()));
    walk(v, "$", shape, 0);
  }
  const out = [`format: jsonl`, `lines=${seen} records=${records} skipped=${Object.entries(skips).sort().map(([k, n]) => `${k}:${n}`).join(",") || "0"}`];
  for (const t of [...types.keys()].sort()) out.push(`${t} n=${types.get(t)}`);
  for (const t of [...shapes.keys()].sort()) {
    out.push(`[${t}]`);
    out.push(...renderShape(shapes.get(t)!));
  }
  return out.join("\n");
}

export function probeJson(path: string): string {
  if (statSync(path).size > MAX_JSON_BYTES) return "format: json\nerror: file too large";
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "format: json\nerror: not valid JSON";
  }
  const shape: Shape = new Map();
  walk(v, "$", shape, 0);
  return ["format: json", ...renderShape(shape, "")].join("\n");
}

function qIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function probeSqlite(path: string): string {
  const reg = new TempRegistry(os.tmpdir());
  try {
    const db = openRo(path, reg);
    if (!db) return "format: sqlite\nerror: cannot open";
    try {
      const out = ["format: sqlite"];
      for (const t of db.tables()) {
        const cols = db.all<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info(?)", t);
        let n = "?";
        try {
          n = String(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${qIdent(t)}`)?.n ?? "?");
        } catch {
          /* virtual table etc. */
        }
        out.push(`table ${t} rows=${n}`);
        for (const c of cols) out.push(`  ${c.name} ${c.type || "(untyped)"}`);
      }
      return out.join("\n");
    } finally {
      db.close();
    }
  } finally {
    reg.disposeAll();
  }
}

function pbLines(fields: Map<number, PbField[]>, depth: number, out: string[]): void {
  const ind = "  ".repeat(depth);
  let printed = 0;
  for (const no of [...fields.keys()].sort((a, b) => a - b)) {
    for (const f of fields.get(no)!) {
      if (printed++ >= 50) {
        out.push(`${ind}...`);
        return;
      }
      if (f.wire === 0) out.push(`${ind}f${f.no} varint`);
      else if (f.wire === 1) out.push(`${ind}f${f.no} fixed64`);
      else if (f.wire === 5) out.push(`${ind}f${f.no} fixed32`);
      else if (f.wire === 2) {
        out.push(`${ind}f${f.no} bytes(${bucket(f.v.length)})`);
        if (depth < 6) {
          const nested = pbTryNested(f.v);
          if (nested) pbLines(nested, depth + 1, out);
        }
      }
    }
  }
}

export function probePbB64(b64: string): string {
  const fields = pbTryNested(b64ToBytes(b64));
  if (!fields) return "format: protobuf\nerror: not protobuf";
  const out = ["format: protobuf"];
  pbLines(fields, 0, out);
  return out.join("\n");
}

function sqliteItemValue(path: string, key: string): string | null {
  const reg = new TempRegistry(os.tmpdir());
  try {
    const db = openRo(path, reg);
    if (!db) return null;
    try {
      const row = db.get<{ value: unknown }>("SELECT value FROM ItemTable WHERE key = ?", key);
      if (!row) return null;
      return row.value instanceof Uint8Array ? new TextDecoder().decode(row.value) : String(row.value);
    } finally {
      db.close();
    }
  } finally {
    reg.disposeAll();
  }
}

async function main(argv: string[]): Promise<string> {
  const args = argv.slice();
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    args.splice(i, 1);
    return true;
  };
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const sqlite = flag("--sqlite");
  const pbKey = opt("--pb-b64");
  const maxLinesRaw = opt("--max-lines");
  const maxLines = maxLinesRaw ? Math.max(1, Number.parseInt(maxLinesRaw, 10) || 5000) : 5000;
  const path = args[0];
  if (pbKey === "-") return probePbB64(await Bun.stdin.text());
  if (!path) return "usage: bun scripts/probe.ts <path> [--sqlite] [--pb-b64 <value-key-or-'-'>] [--max-lines N]";
  if (pbKey !== undefined) {
    if (sqlite) {
      const v = sqliteItemValue(path, pbKey);
      return v === null ? "error: key not found" : probePbB64(v);
    }
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return "error: not valid JSON";
    }
    const v = j !== null && typeof j === "object" ? (j as Record<string, unknown>)[pbKey] : undefined;
    return typeof v === "string" ? probePbB64(v) : "error: field not found or not a string";
  }
  if (sqlite) return probeSqlite(path);
  return /\.jsonl$/i.test(path) ? probeJsonl(path, maxLines) : probeJson(path);
}

if (import.meta.main) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (e) {
    // never echo e.message: it may embed content
    console.log(`error: ${(e as { code?: string })?.code ?? "failed"}`);
    process.exitCode = 1;
  }
}
