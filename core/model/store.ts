import type { Ev, EvOf, SessionEv } from "./events";
import type { Origin } from "./ids";

type Kind = Ev["k"];

/** When merged sessions disagree on origin, the earliest in this list wins: any non-human origin beats `human`. */
const ORIGIN_PRECEDENCE: readonly Origin[] = ["subagent", "peer", "scripted", "scheduled", "system", "human"];

/** Fields with a rule of their own; every other field follows the reports' rank. */
const OWN_RULE = new Set(["k", "tool", "id", "origin", "window", "start", "end", "models"]);

/**
 * How two reports of one session rank for its other fields (source, version, surface, mode, inRepo, projectKey,
 * parentId, approval, sandbox, effort, …): the detail-window report first — its reader saw the session itself, not an
 * index row of it — then the report whose `source` sorts first. Negative when `a` ranks first, 0 for a tie (same window
 * and source).
 */
function rank(a: SessionEv, b: SessionEv): number {
  if (a.window !== b.window) return a.window === "detail" ? -1 : 1;
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

/** Between two reports that tie, the smaller value (numbers and strings by value, false before true). */
function smaller(x: unknown, y: unknown): unknown {
  if (typeof x === typeof y && (typeof x === "number" || typeof x === "string" || typeof x === "boolean")) return (x as never) <= (y as never) ? x : y;
  return JSON.stringify(x) <= JSON.stringify(y) ? x : y;
}

/** JSON with every object's keys sorted: the same text for equal values, whatever order their fields were set in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * One session reported by several readers (a rollout and its index row, a chat session and its store row), the same
 * for any order of the reports. They are sorted by rank — detail window first, then `source` ascending, then their
 * canonical JSON — and folded in that order: start = earliest, end = latest, models = the sorted union, origin by
 * ORIGIN_PRECEDENCE, window `detail` when any report is; each other field takes the first value defined in that order,
 * and among the reports that tie on window and source, the smaller one.
 */
export function mergeSessions(reports: readonly SessionEv[]): SessionEv {
  const order = reports.map((r) => ({ r, json: canonical(r) }))
    .sort((a, b) => rank(a.r, b.r) || (a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
    .map((x) => x.r);
  const first = order[0];
  if (first === undefined) throw new RangeError("mergeSessions: no report");
  const out: Record<string, unknown> = {};
  for (const key of new Set(order.flatMap((r) => Object.keys(r)))) {
    if (OWN_RULE.has(key)) continue;
    let value: unknown;
    let from: SessionEv | undefined; // the first report that defines the field
    for (const r of order) {
      const v = (r as unknown as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (from === undefined) {
        value = v;
        from = r;
      } else if (rank(from, r) === 0) value = smaller(value, v);
      else break;
    }
    if (from !== undefined) out[key] = value;
  }
  const models = [...new Set(order.flatMap((r) => r.models))].sort();
  const origin = order.map((r) => r.origin).reduce((a, b) => (ORIGIN_PRECEDENCE.indexOf(a) <= ORIGIN_PRECEDENCE.indexOf(b) ? a : b));
  const window = order.some((r) => r.window === "detail") ? "detail" : first.window;
  return {
    ...(out as Omit<SessionEv, "k">), k: "session", tool: first.tool, id: first.id, window, origin,
    start: Math.min(...order.map((r) => r.start)), end: Math.max(...order.map((r) => r.end)), models,
  };
}

/** Two reports of one session: `mergeSessions([a, b])`. */
export function mergeSession(a: SessionEv, b: SessionEv): SessionEv {
  return mergeSessions([a, b]);
}

export class EventStore {
  private byKind = new Map<Kind, Ev[]>();
  private sessions = new Map<string, SessionEv>();
  /** Every report received for a session id, in arrival order: a merged session is `mergeSessions` of them all. */
  private reports = new Map<string, SessionEv[]>();
  /** A session's position in the `session` list, so a merge replaces it in place. */
  private sessionAt = new Map<string, number>();
  private index: Map<string, Map<Kind, Ev[]>> | undefined;

  add(e: Ev): void {
    this.index = undefined;
    if (e.k === "session") {
      const reports = this.reports.get(e.id);
      if (reports) {
        reports.push(e);
        const merged = mergeSessions(reports);
        this.sessions.set(e.id, merged);
        this.byKind.get("session")![this.sessionAt.get(e.id)!] = merged;
        return;
      }
      this.reports.set(e.id, [e]);
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
