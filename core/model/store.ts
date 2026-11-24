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

export class EventStore {
  private byKind = new Map<Kind, Ev[]>();
  private sessions = new Map<string, SessionEv>();
  /** Every report received for a session id, in arrival order: a merged session is `mergeSessions` of them all. */
  private reports = new Map<string, SessionEv[]>();
  /** A session's position in the `session` list, so a merge replaces it in place. */
  private sessionAt = new Map<string, number>();
  /**
   * Session ids with a report not merged yet. A report is only queued on `add`; the merge runs once, on the next read of
   * sessions, so a session reported n times costs one merge of n reports, not n merges.
   */
  private unmerged = new Set<string>();
  /**
   * `forSession`'s index, built on first use and dropped by `add`. Compact on purpose (it lives as long as the store):
   * one number per distinct session id, and per kind a CSR table — `order` holds the kind list's positions grouped by
   * session (store order kept within a session), and a session's slice of it runs from `start[slot]` to `start[slot + 1]`.
   */
  private index: { slots: Map<string, number>; byKind: Map<Kind, { order: Uint32Array; start: Uint32Array }> } | undefined;

  add(e: Ev): void {
    this.index = undefined;
    if (e.k === "session") {
      const reports = this.reports.get(e.id);
      if (reports) {
        reports.push(e);
        this.unmerged.add(e.id);
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

  /** Merges every session with reports queued since the last read (`mergeSessions` of all its reports). */
  private merge(): void {
    if (this.unmerged.size === 0) return;
    const list = this.byKind.get("session")!;
    for (const id of this.unmerged) {
      const merged = mergeSessions(this.reports.get(id)!);
      this.sessions.set(id, merged);
      list[this.sessionAt.get(id)!] = merged;
    }
    this.unmerged.clear();
  }

  all<K extends Kind>(k: K): readonly EvOf<K>[] {
    if (k === "session") this.merge();
    return (this.byKind.get(k) ?? []) as EvOf<K>[];
  }

  session(id: string): SessionEv | undefined {
    if (this.unmerged.has(id)) this.merge();
    return this.sessions.get(id);
  }

  forSession<K extends Kind>(id: string, k: K): readonly EvOf<K>[] {
    const index = (this.index ??= this.buildIndex());
    const slot = index.slots.get(id);
    const table = index.byKind.get(k);
    if (slot === undefined || table === undefined) return [];
    const list = this.byKind.get(k)!;
    const from = table.start[slot]!;
    const out = new Array<Ev>(table.start[slot + 1]! - from);
    for (let i = 0; i < out.length; i++) out[i] = list[table.order[from + i]!]!;
    return out as EvOf<K>[];
  }

  private buildIndex(): NonNullable<EventStore["index"]> {
    const slots = new Map<string, number>();
    const byKind = new Map<Kind, { order: Uint32Array; start: Uint32Array }>();
    const tables: Array<[Kind, Int32Array]> = [];
    for (const [kind, list] of this.byKind) {
      const slotOf = new Int32Array(list.length); // transient: each event's slot, −1 without a session id
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const sessionId = (list[i] as { sessionId?: string }).sessionId;
        if (sessionId === undefined) { slotOf[i] = -1; continue; }
        let slot = slots.get(sessionId);
        if (slot === undefined) slots.set(sessionId, (slot = slots.size));
        slotOf[i] = slot;
        any = true;
      }
      if (any) tables.push([kind, slotOf]);
    }
    for (const [kind, slotOf] of tables) {
      const start = new Uint32Array(slots.size + 1);
      for (const slot of slotOf) if (slot >= 0) start[slot + 1]!++;
      for (let s = 0; s < slots.size; s++) start[s + 1]! += start[s]!;
      const next = start.slice(0, slots.size); // transient fill cursors
      const order = new Uint32Array(start[slots.size]!);
      for (let i = 0; i < slotOf.length; i++) {
        const slot = slotOf[i]!;
        if (slot >= 0) order[next[slot]!++] = i;
      }
      byKind.set(kind, { order, start });
    }
    return { slots, byKind };
  }

  count(): Partial<Record<Kind, number>> {
    const out: Partial<Record<Kind, number>> = {};
    for (const [k, list] of this.byKind) if (list.length > 0) out[k] = list.length;
    return out;
  }
}
