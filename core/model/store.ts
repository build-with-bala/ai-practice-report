import type { Ev, EvOf, SessionEv } from "./events";
import type { Origin } from "./ids";

type Kind = Ev["k"];

/** When merged sessions disagree on origin, the earliest in this list wins: any non-human origin beats `human`. */
const ORIGIN_PRECEDENCE: readonly Origin[] = ["subagent", "peer", "scripted", "scheduled", "system", "human"];

/**
 * One session reported by several readers (a rollout and its index row): start = earliest, end = latest, models =
 * union; origin by ORIGIN_PRECEDENCE and window `detail` when either is, so neither depends on arrival order; every
 * other field keeps the first defined value.
 */
function mergeSession(a: SessionEv, b: SessionEv): SessionEv {
  const out: Record<string, unknown> = { ...a };
  for (const [key, val] of Object.entries(b)) {
    if (out[key] === undefined) out[key] = val;
  }
  const models = [...a.models];
  for (const m of b.models) if (!models.includes(m)) models.push(m);
  const origin = ORIGIN_PRECEDENCE.indexOf(a.origin) <= ORIGIN_PRECEDENCE.indexOf(b.origin) ? a.origin : b.origin;
  const window = a.window === "detail" || b.window === "detail" ? "detail" : a.window;
  return { ...(out as unknown as SessionEv), start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), models, origin, window };
}

export class EventStore {
  private byKind = new Map<Kind, Ev[]>();
  private sessions = new Map<string, SessionEv>();
  private index: Map<string, Map<Kind, Ev[]>> | undefined;

  add(e: Ev): void {
    this.index = undefined;
    if (e.k === "session") {
      const prev = this.sessions.get(e.id);
      if (prev) {
        const merged = mergeSession(prev, e);
        this.sessions.set(e.id, merged);
        const list = this.byKind.get("session")!;
        list[list.indexOf(prev)] = merged;
        return;
      }
      this.sessions.set(e.id, e);
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
