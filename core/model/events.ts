import type {
  CheckKind, Intent, MarkerKind, Origin, TechCategory, ToolCategory, ToolId, Window,
} from "./ids";

export interface PromptFeatures { words: number; lenBucket: 0 | 1 | 2 | 3 | 4; hasContext: boolean; fileRefs: number;
  listLines: number; constraintTerms: number; isTaskStart: boolean; techCats: Partial<Record<TechCategory, number>>; simToPrev?: number }
interface Base { tool: ToolId; source: string }   // source = plugin id
export interface SessionEv extends Base { k: "session"; id: string; window: Window; origin: Origin; start: number; end: number; models: string[];
  parentId?: string; projectKey?: string; surface?: string; version?: string; spawnDepth?: number; agentType?: string;
  background?: boolean; workflowId?: string; inRepo?: boolean; approval?: string; sandbox?: string }
export interface PromptEv extends Base { k: "prompt"; ts: number; sessionId?: string; window: Window; origin: Origin; intent: Intent;
  features: PromptFeatures; textHash: string; hasPaste?: boolean }
export interface ToolEv extends Base { k: "tool"; ts: number; sessionId: string; callId?: string; name: string; category: ToolCategory;
  checks?: CheckKind[]; ok?: boolean; exit?: number; ms?: number; editExt?: string; linesAdded?: number; linesRemoved?: number;
  mcpServer?: string; delegateTo?: string }
export interface TurnEv extends Base { k: "turn"; ts: number; sessionId: string; window: Window; model?: string; effort?: string;
  status?: "completed" | "failed" | "interrupted"; ms?: number }
export interface UsageEv extends Base { k: "usage"; ts: number; sessionId: string; model: string; inTok: number; outTok: number; cacheR: number; cacheW: number; usd?: number }
export interface TotalsEv extends Base { k: "totals"; sessionId: string; linesAdded?: number; linesRemoved?: number; usd?: number; ms?: number }
export interface MarkerEv extends Base { k: "marker"; ts: number; sessionId?: string; kind: MarkerKind; detail?: string; n?: number }
export interface ConfigEv extends Base { k: "config"; kind: "skill" | "command" | "agent" | "plugin" | "hook" | "mcp-server" | "memory-file" | "instruction-file" | "profile";
  name?: string; provenance: "authored" | "installed" | "bundled" | "unknown"; uses?: number; lastUsed?: number; checks?: CheckKind[] }
export interface DailyEv extends Base { k: "daily"; day: string; prompts: number; sessions?: number; toolCalls?: number; models?: Record<string, number> }
export interface EdgeEv extends Base { k: "edge"; parentId: string; childId: string }
export interface AnchorEv extends Base { k: "anchor"; kind: "cc-msg" | "cc-req"; ts: number; idTail: string }
export interface IdentityEv extends Base { k: "identity"; scope: "session" | "config"; hash: string; sessionId?: string }
export interface FileFactEv extends Base { k: "file"; pathHash: string; bytes: number; mtime: number; birth?: number; ctime?: number; firstTs?: number; lastTs?: number }
export interface RolloutFactEv extends Base { k: "codex-rollout"; threadId: string; uuidTs?: number; fileTs?: number }
export interface ThreadRowEv extends Base { k: "codex-thread-row"; threadId: string; createdAt?: number }
export interface RateLimitEv extends Base { k: "ratelimit"; ts: number; window: "primary" | "secondary"; windowMinutes?: number; usedPercent: number; resetsAt?: number;
  bucket?: string }   // the provider's rate-limit bucket id (shape-checked), when the trace names one
export interface CommitFactEv extends Base { k: "commit"; ts: number; aiLines?: number; humanLines?: number; repoKey?: string }
export interface CoverageEv extends Base { k: "coverage"; window: Window;
  status: "ok" | "empty" | "absent" | "drift" | "error" | "present-undecodable"; beta: boolean; installed?: boolean;
  from?: number; to?: number; files: number; bytes: number; records: number; skipped: Record<string, number>;
  unknownTypes: Record<string, number>; versions: string[]; retentionDays?: number; note?: string }
export type Ev = SessionEv | PromptEv | ToolEv | TurnEv | UsageEv | TotalsEv | MarkerEv | ConfigEv | DailyEv | EdgeEv
  | AnchorEv | IdentityEv | FileFactEv | RolloutFactEv | ThreadRowEv | RateLimitEv | CommitFactEv | CoverageEv;
export type EvOf<K extends Ev["k"]> = Extract<Ev, { k: K }>;
