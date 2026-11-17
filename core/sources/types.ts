import type { Env } from "../env/env";
import type { Ev } from "../model/events";
import type { Tier, ToolId, Window } from "../model/ids";

export interface TempDirs { dir(): string; disposeAll(): void; readonly active: number }
export interface Candidate { root: string; home: string; wsl: boolean }
export interface ScanCtx { env: Env; now: number; since?: number; salt: Uint8Array; temp: TempDirs; signal: AbortSignal;
  emit(e: Ev): void; hash(v: string): string; registerCwd(cwd: string): string;
  log(level: "debug" | "info" | "warn", code: string, n?: number): void }
export interface SourcePlugin { tool: ToolId; id: string; tier: Tier; beta: boolean;
  /**
   * The windows it reports coverage for (default `["detail"]`): a reader of a detail store and of its index (chat
   * sessions and their store, a conversation index and its step stores) reports both. The orchestrator's own absent,
   * error and aborted coverage is written for each of them too.
   */
  windows?: readonly Window[];
  describe: { reads: string[]; neverReads: string[] };           // human-readable patterns for --explain and the privacy statement
  locate(env: Env, homes: string[]): Candidate[];
  /** Emits all its events, and exactly one CoverageEv per candidate and window it reports, last. */
  scan(c: Candidate, ctx: ScanCtx): Promise<void> }

/** The windows a plugin reports coverage for. */
export const windowsOf = (p: SourcePlugin): readonly Window[] => p.windows ?? ["detail"];
