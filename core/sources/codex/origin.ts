import { sid, type Origin } from "../../model/ids";
import { idPart, isObj, num, str, UUID } from "../common/guards";
import type { ScanCtx } from "../types";

/** Session sources the CLI writes (`SessionSource`, CLI program), but for the subagent object. */
const SOURCES: ReadonlySet<string> = new Set(["cli", "vscode", "exec", "mcp", "custom", "internal", "unknown"]);

/** Agent roles the CLI ships; any other role is a config name and is kept only as a keyed hash. */
const BUILTIN_ROLES: ReadonlySet<string> = new Set(["default", "explorer", "awaiter"]);

/** A Codex thread id as a session id, `codex:<id>`: the CLI's id verbatim when UUID-shaped, else its keyed hash. */
export const cxThreadId = (raw: string, ctx: ScanCtx): string => sid("codex", idPart(raw, UUID, ctx));

/** Who drives a thread and how, as rollouts (`session_meta`) and the thread index (`threads`) both record it. */
export interface CxSource {
  origin: Origin;
  /** The source is a subagent one, whatever the final origin. */
  subagent: boolean;
  /** The source string when the CLI writes it (`SOURCES`), else `other`; `subagent` for subagent sources; absent without a source. */
  surface?: string;
  parentId?: string;
  spawnDepth?: number;
  agentType?: string;
  /** A source that is neither a string nor a `{subagent: …}` object: format drift for the caller to count. */
  unknownShape: boolean;
}

/**
 * The origin of a thread from its `source` — a string (`cli`, `exec`, `vscode`, `mcp`, …) or an object `{subagent: …}` —
 * and its `originator`: `exec` → scripted; `mcp` (Codex run through its MCP server by another client) → peer; a subagent
 * source → subagent, with parent (`thread_spawn.parent_thread_id`, else `parentThreadId`), depth and role; any other
 * string, or none → human. An `originator` of exactly `Claude Code` makes the thread peer, unless its source is a
 * subagent one (subagents inherit the originator and stay subagents). Shared by both readers so they cannot diverge.
 */
export function cxSource(source: unknown, originator: unknown, ctx: ScanCtx, parentThreadId?: unknown): CxSource {
  const s: CxSource = { origin: "human", subagent: false, unknownShape: false };
  if (typeof source === "string") {
    s.origin = source === "exec" ? "scripted" : source === "mcp" ? "peer" : "human";
    s.surface = SOURCES.has(source) ? source : "other";
  } else if (isObj(source) && "subagent" in source) {
    s.origin = "subagent";
    s.subagent = true;
    s.surface = "subagent";
    const spawn = isObj(source.subagent) && isObj(source.subagent.thread_spawn) ? source.subagent.thread_spawn : undefined;
    const parent = str(spawn?.parent_thread_id) ?? str(parentThreadId);
    if (parent !== undefined) s.parentId = cxThreadId(parent, ctx);
    const depth = num(spawn?.depth);
    if (depth !== undefined && Number.isInteger(depth) && depth >= 0) s.spawnDepth = depth;
    const role = str(spawn?.agent_role);
    if (role !== undefined) s.agentType = BUILTIN_ROLES.has(role) ? role : ctx.hash(role);
  } else if (source !== undefined) {
    s.unknownShape = true;
    s.surface = "other";
  }
  if (originator === "Claude Code" && !s.subagent) s.origin = "peer";
  return s;
}
