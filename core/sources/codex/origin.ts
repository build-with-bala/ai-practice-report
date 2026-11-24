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
  /** A source string the CLI is not known to write: drift for the caller to count, and never a human. */
  unknownValue: boolean;
}

/** The origin of a source string the CLI writes: `exec` a script, `mcp` a peer, `internal` the CLI's own work, else the person. */
const KNOWN_ORIGIN = (source: string): Origin => (source === "exec" ? "scripted" : source === "mcp" ? "peer" : source === "internal" ? "system" : "human");

/**
 * The origin of a thread from its `source` — a string (`cli`, `exec`, `vscode`, `mcp`, `internal`, …), or an object with
 * one key, the source's name, holding its data (`{subagent: …}`, `{internal: …}`) — and its `originator`: `exec` →
 * scripted; `mcp` (Codex run through its MCP server by another client) → peer; `internal` (the CLI's own work: memory
 * consolidation, a guardian) → system; a subagent source → subagent, with parent (`thread_spawn.parent_thread_id`,
 * else `parentThreadId`), depth and role; another string the CLI writes, or none → human. An object keyed by another
 * known name maps as that name does, and its data is never read. Anything else — a string the CLI is not known to write
 * (`unknownValue`), an array, an object with another key or several keys, a number (`unknownShape`) — is system and
 * drift: nothing of unknown shape is ever a human. An `originator` of exactly `Claude Code` makes the thread peer,
 * unless its source is a subagent one (subagents inherit the originator and stay subagents). Shared by both readers so
 * they cannot diverge.
 */
export function cxSource(source: unknown, originator: unknown, ctx: ScanCtx, parentThreadId?: unknown): CxSource {
  const s: CxSource = { origin: "human", subagent: false, unknownShape: false, unknownValue: false };
  const keys = isObj(source) ? Object.keys(source) : [];
  if (typeof source === "string") {
    const known = SOURCES.has(source);
    s.origin = known ? KNOWN_ORIGIN(source) : "system";
    s.surface = known ? source : "other";
    s.unknownValue = !known;
  } else if (isObj(source) && keys.length === 1 && keys[0] === "subagent") {
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
  } else if (isObj(source) && keys.length === 1 && SOURCES.has(keys[0]!)) {
    s.origin = KNOWN_ORIGIN(keys[0]!);
    s.surface = keys[0]!;
  } else if (source !== undefined) {
    s.origin = "system";
    s.unknownShape = true;
    s.surface = "other";
  }
  if (originator === "Claude Code" && !s.subagent) s.origin = "peer";
  return s;
}
