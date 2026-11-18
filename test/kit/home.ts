import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv, type Env, type Platform } from "../../core/env/env";

export interface FakeHome {
  root: string;
  env: Env;
  write(rel: string, data: string | Uint8Array): string;
  writeJsonl(rel: string, records: unknown[]): string;
  writeJson(rel: string, v: unknown): string;
  sqlite(rel: string, ddl: string[], rows?: Record<string, unknown[][]>, wal?: boolean): string;
  cleanup(): void;
}

export function fakeHome(platform: Platform = process.platform as Platform): FakeHome {
  const root = mkdtempSync(path.join(os.tmpdir(), "aipr-home-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const win = platform === "win32";
  const env = detectEnv({
    platform,
    home,
    tmp,
    appData: win ? path.join(home, "AppData", "Roaming") : undefined,
    localAppData: win ? path.join(home, "AppData", "Local") : undefined,
    xdgConfig: path.join(home, ".config"),
    xdgData: path.join(home, ".local", "share"),
    xdgState: path.join(home, ".local", "state"),
    vars: {},
    wslHomes: [],
  });
  const abs = (rel: string) => {
    const p = path.join(home, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };
  const write = (rel: string, data: string | Uint8Array) => {
    const p = abs(rel);
    writeFileSync(p, data);
    return p;
  };
  return {
    root,
    env,
    write,
    writeJsonl: (rel, records) => write(rel, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")),
    writeJson: (rel, v) => write(rel, JSON.stringify(v)),
    sqlite(rel, ddl, rows = {}, wal = false) {
      const p = abs(rel);
      const db = new Database(p);
      try {
        if (wal) db.exec("PRAGMA journal_mode=WAL");
        for (const s of ddl) db.exec(s);
        for (const [table, list] of Object.entries(rows)) {
          for (const r of list) {
            db.query(`INSERT INTO "${table.replace(/"/g, '""')}" VALUES (${r.map(() => "?").join(",")})`).run(...(r as never[]));
          }
        }
      } finally {
        db.close();
      }
      return p;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
