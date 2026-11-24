import { keyedHash } from "../text/hash";
import type { AiTool, CommitFact } from "./types";

/** The AI tools a trailer may name, in the order they are tried; each a pattern of whole words, matched case-insensitively. */
const TOOLS: readonly [AiTool, string][] = [
  ["claude", "claude|anthropic"],
  ["codex", "codex|openai|chatgpt"],
  ["copilot", "copilot"],
  ["cursor", "cursor"],
  ["gemini", "gemini|jules"],
  ["antigravity", "antigravity"],
  ["aider", "aider"],
  ["other", "devin|windsurf|codeium|amp|factory|droid|qwen|kiro|cline|roo|kilo|goose|opencode|crush|junie"],
];

/**
 * Words of TOOLS that are also people's names or plain words (Claude, Jules, Devin, Amp, …): in a co-author trailer
 * such a word names the AI tool only with a sign that the co-author is no person (`botSign`). The other words are
 * product names.
 */
const NAME_LIKE: ReadonlySet<string> = new Set(["claude", "jules", "devin", "amp", "factory", "droid", "kiro", "cline", "roo", "kilo", "goose", "crush", "junie"]);
/**
 * Agents' own addresses whose local part is no no-reply word: a local part at its vendor's domain (or a subdomain). A
 * vendor's domain alone is no sign — the vendor's people use it too.
 */
const AGENT_ADDRESSES: readonly [local: string, domain: string][] = [["cursoragent", "cursor.com"], ["amp", "ampcode.com"]];
/**
 * A co-author trailer line. Only spaces and tabs may lead it: `\s*` would also cross line ends, and a message of blank
 * lines then costs time growing with its square.
 */
const CO_AUTHOR = /^[ \t]*co-authored-by:(.*)$/gim;
/** A trailer longer than this (characters) is no real one and is not examined. */
const MAX_TRAILER_CHARS = 1_000;
/**
 * The message text examined at most (characters): a longer message is read as its start and its end (half each), which
 * keep the subject and the trailer block, so every pattern below runs on bounded text.
 */
export const MAX_MESSAGE_CHARS = 16_384;
const GENERATED: readonly [AiTool, RegExp][] = TOOLS.map(([tool, p]) => [tool, new RegExp(`generated (?:with|by) \\[?(?:${p})\\b`, "i")]);
const WORDS: readonly [AiTool, string][] = TOOLS.flatMap(([tool, p]) => p.split("|").map((w): [AiTool, string] => [tool, w]));

/** An address's domain, with its `@`: what is never matched against tool words. */
const AT_DOMAIN = /@[^\s<>,;()]*/g;

/**
 * A co-author trailer's parts: its display name, and its address's local part and domain (lower-cased). The address is
 * the first `<local@domain>` wherever it stands (whatever follows it — a comma, a `(reviewer)` — is dropped), else the
 * first bare `local@domain`; the name is what stands before a bracketed address, or the trailer without its bare one.
 * Any other `@domain` left in the name is dropped too: a malformed trailer never falls back to matching its whole text.
 */
function trailerParts(trailer: string): { name: string; local: string; domain: string } {
  const t = trailer.trim();
  const bracketed = /<([^<>@\s]*)@([^<>\s]*)>/.exec(t);
  if (bracketed) {
    return { name: t.slice(0, bracketed.index).replace(AT_DOMAIN, ""), local: bracketed[1]!.toLowerCase(), domain: bracketed[2]!.toLowerCase() };
  }
  const bare = bareAddress(t);
  if (!bare) return { name: t.replace(AT_DOMAIN, ""), local: "", domain: "" };
  const name = t.slice(0, bare.start) + t.slice(bare.end);
  return { name: name.replace(AT_DOMAIN, ""), local: bare.local.toLowerCase(), domain: bare.domain.toLowerCase() };
}

/** A character a bare address may hold (any but white space and `<>,;()`). */
const ADDRESS_CHAR = /[^\s<>,;()]/;

/**
 * The first bare `local@domain` of `t`, found in linear time: the run of address characters around the first `@`, its
 * local part up to the run's last `@` — what the pattern `([^\s<>,;()]*)@([^\s<>,;()]*)` matches first, without its
 * cost (it retries every start of a long run with no `@`, in time growing with the run's square).
 */
function bareAddress(t: string): { start: number; end: number; local: string; domain: string } | undefined {
  const at = t.indexOf("@");
  if (at === -1) return undefined;
  let start = at;
  while (start > 0 && ADDRESS_CHAR.test(t[start - 1]!)) start--;
  let end = at + 1;
  while (end < t.length && ADDRESS_CHAR.test(t[end]!)) end++;
  const run = t.slice(start, end);
  const last = run.lastIndexOf("@");
  return { start, end, local: run.slice(0, last), domain: run.slice(last + 1) };
}

/**
 * The co-author is no person: `[bot]` in its name or address, a no-reply local part (`noreply`, `no-reply`, `noreply+…`),
 * or a known agent address (AGENT_ADDRESSES).
 */
function botSign(t: { name: string; local: string; domain: string }): boolean {
  if (/\[bot\]/i.test(t.name) || t.local.includes("[bot]")) return true;
  if (/^no-?reply(?:[+.-]|$)/.test(t.local)) return true;
  return AGENT_ADDRESSES.some(([local, domain]) => t.local === local && (t.domain === domain || t.domain.endsWith(`.${domain}`)));
}

/**
 * The AI tool a co-author trailer (`Name <local@domain>`) names: the first word of WORDS standing whole in its display
 * name or its address's local part — never in the domain, so `pat@anthropic.com` is a person. A name-like word
 * (NAME_LIKE) counts only with a bot sign.
 */
function coAuthorTool(trailer: string): AiTool | undefined {
  if (trailer.length > MAX_TRAILER_CHARS) return undefined;
  const t = trailerParts(trailer);
  const bot = botSign(t);
  for (const [tool, word] of WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (!re.test(t.name) && !re.test(t.local)) continue;
    if (!NAME_LIKE.has(word) || bot) return tool;
  }
  return undefined;
}

/** The first tool whose pattern a text matches. */
const toolIn = (text: string, list: readonly [AiTool, RegExp][]): AiTool | undefined => list.find(([, re]) => re.test(text))?.[0];

/**
 * What a commit message says, in memory only (the message is dropped; one longer than MAX_MESSAGE_CHARS is read as its
 * start and its end): `ai`, the AI tool of its first `Co-authored-by:`
 * trailer that names one (`coAuthorTool`: people are ignored, a person named like a tool included); `generated`, the
 * tool of a "Generated with/by [tool" line; `rework`, from the subject — `Revert "…` (revert), `fixup! `/`squash! `/
 * `amend! ` (fixup), `fix:`/`hotfix:`/`bugfix:` with an optional scope and `!` (fix).
 */
export function classifyCommit(full: string): Pick<CommitFact, "ai" | "generated" | "rework"> {
  const half = MAX_MESSAGE_CHARS / 2;
  const message = full.length <= MAX_MESSAGE_CHARS ? full : `${full.slice(0, half)}\n${full.slice(full.length - half)}`;
  const out: Pick<CommitFact, "ai" | "generated" | "rework"> = {};
  for (const m of message.matchAll(CO_AUTHOR)) {
    const tool = coAuthorTool(m[1]!);
    if (tool !== undefined) {
      out.ai = tool;
      break;
    }
  }
  for (const line of message.split("\n")) {
    const tool = toolIn(line, GENERATED);
    if (tool !== undefined) {
      out.generated = tool;
      break;
    }
  }
  const subject = message.split("\n", 1)[0] ?? "";
  if (/^Revert "/.test(subject)) out.rework = "revert";
  else if (/^(?:fixup|squash|amend)! /.test(subject)) out.rework = "fixup";
  else if (/^(?:fix|hotfix|bugfix)(?:\([^)]*\))?!?:/.test(subject)) out.rework = "fix";
  return out;
}

/** A commit's id: the keyed hash (16 lowercase hex digits) of its full sha, lower-cased — the same in every clone, never the sha. */
export const commitId = (salt: Uint8Array, sha: string): string => keyedHash(salt, sha.toLowerCase(), 16);

/** A commit's key: the keyed hash of its sha's first 7 hex digits, lower-cased — what a Claude Code commit marker keys. */
export const shaKey = (salt: Uint8Array, sha: string): string => keyedHash(salt, sha.slice(0, 7).toLowerCase());

const HEAD = "\x1e";
const FIELD = "\x1f";

/**
 * `git log -z` with this format: each commit is the token `\x1e<sha>\x1f<commit time>\x1f<author email>\n<message>`
 * right after an empty token (the format's leading `%x00` ends whatever came before); with `--name-only`, its changed
 * paths follow as NUL-ended tokens, the first after a newline. A NUL occurs in no message or path, and a path token is
 * never empty, so only a header follows an empty token: neither a message nor a path can forge or hide a record. The
 * sha and the time hold no separator; the email is everything up to the first newline (git prints it raw, and an email
 * may hold `\x1f` or `\x1e`, but never a newline, which would end its header line), so a separator in an email stays
 * in that email: it can only make the email differ from the person's, never shift a field.
 */
export const LOG_ARGS: readonly string[] = ["-z", "--format=%x00%x1e%H%x1f%ct%x1f%ae%n%B"];

/** The first git with `--since-as-filter`. */
export const SINCE_AS_FILTER_SINCE: readonly [number, number] = [2, 37];

/**
 * The window start of a `git log` (epoch ms, formatted here): `--since-as-filter` on a git that has it (`asFilter`), which
 * walks the whole history and leaves out only the commits older than the window; `--since` otherwise. Plain `--since`
 * stops walking at a commit whose recorded date is older than the window, so on a git before 2.37 such a commit (a
 * skewed clock, a rebase that keeps old dates) hides its ancestors that no other branch reaches.
 */
export const sinceArg = (ms: number, asFilter: boolean): string => `${asFilter ? "--since-as-filter" : "--since"}=${new Date(ms).toISOString()}`;

/** One commit record of `git log` output of LOG_ARGS (in memory only). */
export interface LogRecord { sha: string; ct: number; email: string; message: string; files: string[] }

const NUL = 0;

/**
 * `git log` output of LOG_ARGS parsed as it streams, record by record: `push` each chunk as it arrives (the chunk is
 * not kept: only the bytes of the token it leaves unfinished are copied), `end` once the output is over. Each record is
 * handed to `onRecord` once it is complete — at the next header, or at the end — so what is held is one record plus the
 * unfinished token, never the output.
 *
 * Tokens are NUL-ended. A header (an empty token, then one starting `\x1e`) must hold a hex sha, a time of 1 to 12 digits
 * and an email ended by a newline; one that does not is left out with the paths after it. Only a record's first path
 * loses a leading newline (git's separator after the message). `maxFiles`: paths kept per record (the
 * rest are dropped as they stream; default all). The tokens and records are those of splitting the whole output at
 * NUL, so `logRecords` (the whole-output form) and the stream agree byte for byte.
 */
export class LogStream {
  /**
   * Each token is decoded on its own, so the decoder must change nothing a single decode of the whole output would not:
   * `ignoreBOM`, since a non-streaming decode would strip a leading U+FEFF from every token (a BOM-only path would read
   * as an empty token, and a BOM-prefixed path as a header). The output itself never starts with a BOM (its first byte
   * is NUL). A token ends at a NUL, which is never inside a UTF-8 sequence, so invalid or unfinished sequences decode to
   * the same U+FFFD per token as in the whole; a character split across chunks is decoded only once its token is whole.
   */
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private tokens = 0;
  private prevEmpty = false;
  private cur: LogRecord | undefined;
  private emitted = 0;
  private done = false;
  /** Path tokens seen in the current record. */
  private paths = 0;
  constructor(private readonly onRecord: (r: LogRecord) => void, private readonly o: { maxFiles?: number } = {}) {}

  /** The bytes of the unfinished token held between chunks. */
  get buffered(): number {
    return this.pendingBytes;
  }

  /** Records handed out so far. */
  get records(): number {
    return this.emitted;
  }

  push(chunk: Uint8Array): void {
    if (this.done) return;
    let pos = 0;
    while (pos < chunk.length) {
      const nul = chunk.indexOf(NUL, pos);
      if (nul === -1) {
        const rest = chunk.slice(pos); // a copy: the chunk's buffer is never kept
        this.pending.push(rest);
        this.pendingBytes += rest.length;
        return;
      }
      this.token(this.take(chunk.subarray(pos, nul)));
      pos = nul + 1;
    }
  }

  /** The output is over: its last token, then its last record. Returns the records handed out. */
  end(): number {
    if (this.done) return this.emitted;
    this.done = true;
    this.token(this.take(new Uint8Array(0)));
    this.flush();
    return this.emitted;
  }

  /** The unfinished token's bytes followed by `tail`, decoded; the held bytes are released. */
  private take(tail: Uint8Array): string {
    if (this.pending.length === 0) return this.decoder.decode(tail);
    const bytes = new Uint8Array(this.pendingBytes + tail.length);
    let at = 0;
    for (const p of this.pending) {
      bytes.set(p, at);
      at += p.length;
    }
    bytes.set(tail, at);
    this.pending = [];
    this.pendingBytes = 0;
    return this.decoder.decode(bytes);
  }

  private flush(): void {
    if (this.cur === undefined) return;
    const r = this.cur;
    this.cur = undefined;
    this.emitted++;
    this.onRecord(r);
  }

  private token(token: string): void {
    const first = this.tokens++ === 0;
    if (token === "") {
      this.prevEmpty = true;
      return;
    }
    if (!first && this.prevEmpty && token.startsWith(HEAD)) {
      this.flush();
      const a = token.indexOf(FIELD, 1);
      const b = a === -1 ? -1 : token.indexOf(FIELD, a + 1);
      const nl = b === -1 ? -1 : token.indexOf("\n", b + 1);
      const sha = a === -1 ? "" : token.slice(1, a);
      const ct = b === -1 ? "" : token.slice(a + 1, b);
      const valid = nl !== -1 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha) && /^[0-9]{1,12}$/.test(ct);
      this.cur = valid ? { sha, ct: Number(ct), email: token.slice(b + 1, nl), message: token.slice(nl + 1), files: [] } : undefined;
      this.paths = 0;
    } else if (this.cur) {
      // the first path follows the message after a newline: only it loses one
      const first = this.paths++ === 0;
      if (this.o.maxFiles === undefined || this.cur.files.length < this.o.maxFiles) this.cur.files.push(first ? token.replace(/^\n/, "") : token);
    }
    this.prevEmpty = false;
  }
}

/**
 * The records of `git log` output of LOG_ARGS (all authors'), as LogStream reads them. `cut`: the output was cut short,
 * so its last record (possibly incomplete) is left out.
 */
export function logRecords(stdout: string, o: { cut?: boolean } = {}): LogRecord[] {
  const out: LogRecord[] = [];
  const stream = new LogStream((r) => out.push(r));
  stream.push(new TextEncoder().encode(stdout));
  stream.end();
  if (o.cut) out.pop();
  return out;
}

/** A commit of the person's as keyed facts, with its full sha (memory only, for the pass: never stored). */
export interface ParsedCommit { fact: CommitFact; sha: string }

export interface CommitOptions { salt: Uint8Array; email: string; maxFiles: number }

/**
 * The person's commits of a streamed `git log` output of LOG_ARGS: `push` its chunks, then `end(cut)`. Each record is
 * reduced to keyed facts as soon as it is complete (its message and paths are dropped then): only those whose author
 * email equals `o.email` (case-insensitively), each with `id` (`commitId`), `mine` true, `ts` = commit time in ms, `shaKey`, the trailers
 * `classifyCommit` reads, up to `o.maxFiles` changed paths as keyed hashes, and `owner` true (a later pass decides
 * between repos). The last record is held back as facts until the next one or the end, so a `cut` output (its last
 * record possibly incomplete) leaves it out, as `logRecords` does. `records`: every author's records, the left-out one
 * not counted; `oldest`: the smallest commit time (epoch ms) among those records, absent when there is none.
 */
export function commitStream(o: CommitOptions): { push(chunk: Uint8Array): void; end(cut: boolean): { commits: ParsedCommit[]; records: number; oldest?: number } } {
  const email = o.email.trim().toLowerCase();
  const commits: ParsedCommit[] = [];
  let last: ParsedCommit | null | undefined; // the last record's facts (null: another author's), not yet kept
  let records = 0;
  let oldest: number | undefined; // the smallest commit time (ms) of the records counted, any author's
  let lastTs = 0;
  const keep = () => {
    if (last === undefined) return;
    if (last !== null) commits.push(last);
    records++;
    if (oldest === undefined || lastTs < oldest) oldest = lastTs;
  };
  const stream = new LogStream((r) => {
    keep();
    lastTs = r.ct * 1000;
    const sha = r.sha.toLowerCase();
    last = r.email.trim().toLowerCase() !== email ? null : { sha, fact: { id: commitId(o.salt, sha), ts: r.ct * 1000, shaKey: shaKey(o.salt, r.sha),
      ...classifyCommit(r.message), files: r.files.slice(0, o.maxFiles).map((f) => keyedHash(o.salt, f)), owner: true, mine: true } };
  }, { maxFiles: o.maxFiles });
  return {
    push: (chunk) => stream.push(chunk),
    end: (cut) => {
      stream.end();
      if (!cut) keep();
      last = undefined;
      return oldest === undefined ? { commits, records } : { commits, records, oldest };
    },
  };
}

/** The person's commits in a whole `git log` output of LOG_ARGS (`commitStream` over it). `cut` as for `logRecords`. */
export function parseCommits(stdout: string, o: CommitOptions & { cut?: boolean }): ParsedCommit[] {
  const s = commitStream(o);
  s.push(new TextEncoder().encode(stdout));
  return s.end(o.cut ?? false).commits;
}

/** `parseCommits` without the shas: the facts only. */
export const parseLog = (stdout: string, o: CommitOptions & { cut?: boolean }): CommitFact[] =>
  parseCommits(stdout, o).map((c) => c.fact);
