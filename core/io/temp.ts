import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

/**
 * A scan's temp dirs, under one base folder `<tmp>/aipr-scan-*` that is made on the first `dir()`: a scan that needs no
 * private copy never touches the temp folder, so a missing or read-only one cannot fail it (a copy that needs it fails
 * on its own, and its store counts as unreadable). `factory` builds the registry inside the base (a test seam).
 */
export class ScanTemp implements TempDirs {
  private base?: string;
  private reg?: TempDirs;

  constructor(private readonly tmp: string, private readonly factory: (base: string) => TempDirs = (base) => new TempRegistry(base)) {}

  dir(): string {
    if (!this.reg) {
      this.base ??= mkdtempSync(path.join(this.tmp, "aipr-scan-"));
      this.reg = this.factory(this.base);
    }
    return this.reg.dir();
  }

  disposeAll(): void {
    this.reg?.disposeAll();
  }

  get active(): number {
    return this.reg?.active ?? 0;
  }

  /**
   * Disposes of every dir, then removes the base folder (and whatever is left in it). True when nothing was left: the
   * dirs were all disposed of and the base was empty when removed.
   */
  close(): boolean {
    let clean = true;
    try {
      this.reg?.disposeAll();
    } catch {
      clean = false;
    }
    if (this.base === undefined) return clean;
    try {
      if (existsSync(this.base) && readdirSync(this.base).length > 0) clean = false;
    } catch {
      clean = false;
    }
    try {
      rmSync(this.base, { recursive: true, force: true });
    } catch {
      clean = false;
    }
    return clean;
  }
}
