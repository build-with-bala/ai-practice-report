import type { Env } from "../env/env";
import type { Ev } from "../model/events";
import type { Tier, ToolId, Window } from "../model/ids";

export interface TempDirs { dir(): string; disposeAll(): void; readonly active: number }
export interface Candidate { root: string; home: string; wsl: boolean }
export interface ScanCtx { env: Env; now: number; since?: number; salt: Uint8Array; temp: TempDirs; signal: AbortSignal;
  emit(e: Ev): void; hash(v: string): string; registerCwd(cwd: string): string;
  log(level: "debug" | "info" | "warn", code: string, n?: number): void }
export interface SourcePlugin { tool: ToolId; id: string; tier: Tier; beta: boolean;
  window?: Window;                                                // the window of the coverage it reports (default detail); the
                                                                  // orchestrator's own absent/error/aborted coverage uses it too
  describe: { reads: string[]; neverReads: string[] };           // human-readable patterns for --explain and the privacy statement
  locate(env: Env, homes: string[]): Candidate[];
  scan(c: Candidate, ctx: ScanCtx): Promise<void> }               // emits all events incl. exactly one CoverageEv per candidate
