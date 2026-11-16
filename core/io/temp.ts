import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { TempDirs } from "../sources/types";

/** Private 0700 scratch dirs; only ever removes dirs it created itself. */
export class TempRegistry implements TempDirs {
  private dirs = new Set<string>();
  constructor(private baseTmp: string) {}

  dir(): string {
    const d = mkdtempSync(path.join(this.baseTmp, "aipr-"));
    chmodSync(d, 0o700);
    this.dirs.add(d);
    return d;
  }

  disposeAll(): void {
    for (const d of this.dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.dirs.clear();
  }

  get active(): number {
    return this.dirs.size;
  }
}

/** On SIGINT/SIGTERM: dispose temp dirs, drop handlers, re-raise. Returns uninstall. */
export function installSignalCleanup(reg: TempDirs): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const uninstall = () => {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    handlers.clear();
  };
  for (const sig of signals) {
    const h = () => {
      try {
        reg.disposeAll();
      } finally {
        uninstall();
        process.kill(process.pid, sig);
      }
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
  return uninstall;
}
