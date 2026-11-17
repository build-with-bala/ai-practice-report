import type { Ev, EvOf, SessionEv } from "./events";
import type { Origin } from "./ids";

type Kind = Ev["k"];

/** When merged sessions disagree on origin, the earliest in this list wins: any non-human origin beats `human`. */
const ORIGIN_PRECEDENCE: readonly Origin[] = ["subagent", "peer", "scripted", "scheduled", "system", "human"];

/** Fields with a rule of their own; every other field follows `rank`. */
const OWN_RULE = new Set(["k", "tool", "id", "origin", "window", "start", "end", "models"]);

/**
 * Which of two reports of one session decides its other fields (source, version, surface, mode, inRepo, projectKey,
 * parentId, approval, sandbox, effort, …): the detail-window report first — its reader saw the session itself, not an
 * index row of it — then the report whose `source` sorts first. Negative when `a` ranks first, 0 for a tie (same window
 * and source).
 */
function rank(a: SessionEv, b: SessionEv): number {
  if (a.window !== b.window) return a.window === "detail" ? -1 : 1;
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

/** Between two reports that tie, the smaller value (numbers and strings by value, false before true): any arrival order gives the same. */
function smaller(x: unknown, y: unknown): unknown {
  if (typeof x === typeof y && (typeof x === "number" || typeof x === "string" || typeof x === "boolean")) return (x as never) <= (y as never) ? x : y;
  return JSON.stringify(x) <= JSON.stringify(y) ? x : y;
}

/**
 * One session reported by several readers (a rollout and its index row, a chat session and its store row): start =
 * earliest, end = latest, models = the sorted union, origin by ORIGIN_PRECEDENCE, window `detail` when either is; each
 * other field takes the value of the report that ranks first (`rank`) when it has one, else the other's. Nothing depends
 * on the order the reports arrive in.
 */
export function mergeSession(a: SessionEv, b: SessionEv): SessionEv {
  const r = rank(a, b);
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (OWN_RULE.has(key)) continue;
    const x = (a as unknown as Record<string, unknown>)[key];
    const y = (b as unknown as Record<string, unknown>)[key];
    const v = x === undefined ? y : y === undefined ? x : r < 0 ? x : r > 0 ? y : smaller(x, y);
    if (v !== undefined) out[key] = v;
  }
  const models = [...new Set([...a.models, ...b.models])].sort();
  const origin = ORIGIN_PRECEDENCE.indexOf(a.origin) <= ORIGIN_PRECEDENCE.indexOf(b.origin) ? a.origin : b.origin;
  const window = a.window === "detail" || b.window === "detail" ? "detail" : a.window;
  return { ...(out as Omit<SessionEv, "k">), k: "session", tool: a.tool, id: a.id, window, origin, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), models };
}

export class EventStore {
  private byKind = new Map<Kind, Ev[]>();
  private sessions = new Map<string, SessionEv>();
  /** A session's position in the `session` list, so a merge replaces it in place. */
  private sessionAt = new Map<string, number>();
  private index: Map<string, Map<Kind, Ev[]>> | undefined;

  add(e: Ev): void {
    this.index = undefined;
    if (e.k === "session") {
      const prev = this.sessions.get(e.id);
      if (prev) {
        const merged = mergeSession(prev, e);
        this.sessions.set(e.id, merged);
        this.byKind.get("session")![this.sessionAt.get(e.id)!] = merged;
        return;
      }
      this.sessions.set(e.id, e);
      this.sessionAt.set(e.id, this.byKind.get("session")?.length ?? 0);
    }
    const list = this.byKind.get(e.k);
    if (list) list.push(e);
    else this.byKind.set(e.k, [e]);
  }

  all<K extends Kind>(k: K): readonly EvOf<K>[] {
    return (this.byKind.get(k) ?? []) as EvOf<K>[];
  }

  session(id: string): SessionEv | undefined {
    return this.sessions.get(id);
  }

  forSession<K extends Kind>(id: string, k: K): readonly EvOf<K>[] {
    if (!this.index) {
      const idx = new Map<string, Map<Kind, Ev[]>>();
      for (const [kind, list] of this.byKind) {
        for (const ev of list) {
          const sessionId = (ev as { sessionId?: string }).sessionId;
          if (sessionId === undefined) continue;
          let perKind = idx.get(sessionId);
          if (!perKind) idx.set(sessionId, (perKind = new Map()));
          const bucket = perKind.get(kind);
          if (bucket) bucket.push(ev);
          else perKind.set(kind, [ev]);
        }
      }
      this.index = idx;
    }
    return (this.index.get(id)?.get(k) ?? []) as EvOf<K>[];
  }

  count(): Partial<Record<Kind, number>> {
    const out: Partial<Record<Kind, number>> = {};
    for (const [k, list] of this.byKind) if (list.length > 0) out[k] = list.length;
    return out;
  }
}
