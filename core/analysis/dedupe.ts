import type { PromptEv } from "../model/events";
import type { SessionRow } from "./types";

/** Two prompts with an equal text hash from different tools, at most this far apart, are one prompt typed once. */
export const PAIR_WINDOW_MS = 60_000;
/** A session pair is one session reported twice only when at least this share of BOTH sides' pairable prompts pair… */
export const HOST_SHARE = 0.5;
/** …and at least this many prompts pair. */
export const HOST_MIN_PAIRS = 3;
/** Prompts this short ("yes", "continue") are typed everywhere: they never pair. */
export const MAX_SHORT_WORDS = 2;

export interface DedupeResult {
  /** The host copies: left out of every metric. */
  hosts: Set<string>;
  /** Scripted prompts of the other side of a host pair: the person typed them (in the host). */
  relabelled: Set<PromptEv>;
  /** The sessions holding relabelled prompts. */
  relabelledSessions: Set<string>;
  pairedPrompts: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Which of two sessions that report the same work is the host copy: the Copilot session from VS Code (the agent host
 * that relays another tool's session), else the one whose tool sorts later.
 */
function hostOf(a: SessionRow, b: SessionRow): SessionRow {
  const vsc = (r: SessionRow) => r.tool === "copilot" && r.surface === "vscode";
  if (vsc(a) !== vsc(b)) return vsc(a) ? a : b;
  return cmp(a.tool, b.tool) >= 0 ? a : b;
}

/**
 * The cross-tool dedupe (builder's call 9, as amended) over detail-window prompts of kept rows:
 * 1. pairable prompts: human or scripted, with more than MAX_SHORT_WORDS words (a short prompt never pairs and is not
 *    counted in a session's share);
 * 2. pairable prompts from different tools with an equal `textHash` within PAIR_WINDOW_MS pair, one to one, earliest first;
 * 3. a session pair is a host copy only when at least HOST_MIN_PAIRS prompts pair AND the paired share is at least
 *    HOST_SHARE on BOTH sides (an agent host mirrors the whole session; a coincidental prompt does not); `hostOf` picks
 *    which side is the copy;
 * 4. in the other session, the paired prompts whose origin is `scripted` are relabelled human.
 * `pairedPrompts` counts every pair of step 2; `relabelled` only those of step 4.
 */
export function dedupe(prompts: readonly PromptEv[], rows: ReadonlyMap<string, SessionRow>): DedupeResult {
  const eligible: PromptEv[] = [];
  const perSession = new Map<string, number>();
  for (const p of prompts) {
    if (p.window !== "detail" || p.sessionId === undefined || !rows.has(p.sessionId)) continue;
    if (p.origin !== "human" && p.origin !== "scripted") continue;
    if (p.features.words <= MAX_SHORT_WORDS) continue;
    eligible.push(p);
    perSession.set(p.sessionId, (perSession.get(p.sessionId) ?? 0) + 1);
  }

  const byHash = new Map<string, PromptEv[]>();
  for (const p of eligible) {
    const list = byHash.get(p.textHash);
    if (list) list.push(p);
    else byHash.set(p.textHash, [p]);
  }
  /** Session pair ("a\0b", a < b) → its prompt pairs. */
  const pairs = new Map<string, [PromptEv, PromptEv][]>();
  let pairedPrompts = 0;
  for (const hash of [...byHash.keys()].sort()) {
    const list = byHash.get(hash)!;
    if (list.length < 2) continue;
    list.sort((a, b) => a.ts - b.ts || cmp(a.tool, b.tool) || cmp(a.sessionId!, b.sessionId!));
    const used = new Array<boolean>(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      const p = list[i]!;
      for (let j = i + 1; j < list.length && list[j]!.ts - p.ts <= PAIR_WINDOW_MS; j++) {
        const q = list[j]!;
        if (used[j] || q.tool === p.tool) continue;
        used[i] = used[j] = true;
        pairedPrompts++;
        const [a, b] = cmp(p.sessionId!, q.sessionId!) <= 0 ? [p, q] : [q, p];
        const key = `${a.sessionId}\u0000${b.sessionId}`;
        const at = pairs.get(key);
        if (at) at.push([a, b]);
        else pairs.set(key, [[a, b]]);
        break;
      }
    }
  }

  const hosts = new Set<string>();
  const hostPairs: [string, [PromptEv, PromptEv][]][] = [];
  for (const key of [...pairs.keys()].sort()) {
    const list = pairs.get(key)!;
    const [a, b] = key.split("\u0000") as [string, string];
    if (list.length < HOST_MIN_PAIRS) continue;
    const share = Math.min(list.length / perSession.get(a)!, list.length / perSession.get(b)!);
    if (share < HOST_SHARE) continue;
    hosts.add(hostOf(rows.get(a)!, rows.get(b)!).id);
    hostPairs.push([key, list]);
  }

  const relabelled = new Set<PromptEv>();
  const relabelledSessions = new Set<string>();
  for (const [, list] of hostPairs) {
    for (const pair of list) {
      const kept = pair.filter((p) => !hosts.has(p.sessionId!));
      if (kept.length !== 1) continue; // both hosts (of other pairs) or neither: nothing to relabel
      const p = kept[0]!;
      if (p.origin !== "scripted") continue;
      relabelled.add(p);
      relabelledSessions.add(p.sessionId!);
    }
  }
  return { hosts, relabelled, relabelledSessions, pairedPrompts };
}
