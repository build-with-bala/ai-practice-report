import { isObj, type Obj } from "../common/guards";

/**
 * VS Code's chat session journal (`chatSessions/<id>.jsonl`, VS Code 1.109+): one record per line, applied in order to
 * rebuild the session object (VS Code's own reader, 1.138):
 * - `{kind:0, v}` — initial entry: the root becomes `v` (VS Code writes one again when it compacts the log);
 * - `{kind:1, k, v}` — set `v` at path `k`;
 * - `{kind:2, k, v?, i?}` — push: the array at `k` (created when absent) is first cut to length `i` when `i` is given,
 *   then the items of `v` are appended;
 * - `{kind:3, k}` — delete the value at `k`.
 * A set or delete at an empty path changes nothing, as in VS Code.
 * `k` is an array of keys and array indices. See FORMAT.md.
 */

/** A problem found while replaying: `bad-record` (a record that cannot be applied) or `journal-kind:<n>` (a kind VS Code does not write). */
export type JournalIssue = (key: string) => void;

/** Keys that would reach an object's prototype; a path naming one is a bad record. */
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const KIND = /^\d{1,3}$/;

type Container = Obj | unknown[];
const isContainer = (v: unknown): v is Container => typeof v === "object" && v !== null;

/** A path segment: a non-negative integer index or a key that cannot reach a prototype. */
const segment = (s: unknown): s is string | number =>
  (typeof s === "number" && Number.isInteger(s) && s >= 0) || (typeof s === "string" && !UNSAFE.has(s));

/** The container holding the last segment of `k`, walking own properties only; undefined when the path leads nowhere. */
function parentOf(root: unknown, k: (string | number)[]): Container | undefined {
  let cur: unknown = root;
  for (let n = 0; n < k.length - 1; n++) {
    if (!isContainer(cur) || !Object.hasOwn(cur, k[n]!)) return undefined;
    cur = (cur as Record<string | number, unknown>)[k[n]!];
  }
  return isContainer(cur) ? cur : undefined;
}

/** Applies journal records one at a time, so a reader can stream a journal line by line; `root` is the session so far. */
export class Journal {
  root: unknown;

  constructor(private readonly issue: JournalIssue = () => {}) {}

  apply(rec: unknown): void {
    if (!isObj(rec)) return this.issue("bad-record");
    const kind = rec.kind;
    if (kind === 0) {
      this.root = rec.v;
      return;
    }
    if (kind !== 1 && kind !== 2 && kind !== 3) {
      return this.issue(`journal-kind:${typeof kind === "number" && KIND.test(String(kind)) ? kind : "(other)"}`);
    }
    if (this.root === undefined || !Array.isArray(rec.k) || !rec.k.every(segment)) return this.issue("bad-record");
    const k = rec.k as (string | number)[];
    if (k.length === 0) {
      if (kind === 2) this.issue("bad-record"); // VS Code ignores a set or delete at an empty path; a push needs an array
      return;
    }
    const parent = parentOf(this.root, k);
    if (parent === undefined) return this.issue("bad-record");
    const last = k[k.length - 1]!;
    const target = parent as Record<string | number, unknown>;
    if (kind === 1) target[last] = rec.v;
    else if (kind === 3) delete target[last];
    else this.push(target, last, rec);
  }

  private push(target: Record<string | number, unknown>, last: string | number, rec: Obj): void {
    const cur = Object.hasOwn(target, last) ? target[last] : undefined;
    if (cur !== undefined && cur !== null && !Array.isArray(cur)) return this.issue("bad-record");
    if (rec.v !== undefined && !Array.isArray(rec.v)) return this.issue("bad-record");
    const i = rec.i;
    if (i !== undefined && !(typeof i === "number" && Number.isInteger(i) && i >= 0)) return this.issue("bad-record");
    const arr: unknown[] = Array.isArray(cur) ? cur : [];
    if (typeof i === "number" && i < arr.length) arr.length = i;
    if (Array.isArray(rec.v)) for (const item of rec.v) arr.push(item);
    target[last] = arr;
  }
}

/**
 * The session object a journal's records build, applied in order (pure: the records passed in are not changed). Records
 * that cannot be applied are reported through `issue` and skipped; replay goes on with the next one.
 */
export function replayJournal(records: unknown[], issue?: JournalIssue): unknown {
  const journal = new Journal(issue);
  for (const rec of structuredClone(records)) journal.apply(rec);
  return journal.root;
}
