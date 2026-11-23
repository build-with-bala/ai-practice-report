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
const CO_AUTHOR = /^\s*co-authored-by:(.*)$/gim;
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
  const bare = bracketed ? undefined : /([^\s<>,;()]*)@([^\s<>,;()]*)/.exec(t);
  const m = bracketed ?? bare;
  if (!m) return { name: t.replace(AT_DOMAIN, ""), local: "", domain: "" };
  const name = bracketed ? t.slice(0, m.index) : t.slice(0, m.index) + t.slice(m.index + m[0].length);
  return { name: name.replace(AT_DOMAIN, ""), local: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() };
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
 * What a commit message says, in memory only (the message is dropped): `ai`, the AI tool of its first `Co-authored-by:`
 * trailer that names one (`coAuthorTool`: people are ignored, a person named like a tool included); `generated`, the
 * tool of a "Generated with/by [tool" line; `rework`, from the subject — `Revert "…` (revert), `fixup! `/`squash! `/
 * `amend! ` (fixup), `fix:`/`hotfix:`/`bugfix:` with an optional scope and `!` (fix).
 */
export function classifyCommit(message: string): Pick<CommitFact, "ai" | "generated" | "rework"> {
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

/** A commit's key: the keyed hash of its sha's first 7 hex digits, lower-cased — what a Claude Code commit marker keys. */
export const shaKey = (salt: Uint8Array, sha: string): string => keyedHash(salt, sha.slice(0, 7).toLowerCase());

const HEAD = "\x1e";
const FIELD = "\x1f";

/**
 * `git log -z` with this format: each commit is the token `\x1e<sha>\x1f<commit time>\x1f<author email>\x1f<message>`
 * right after an empty token (the format's leading `%x00` ends whatever came before); with `--name-only`, its changed
 * paths follow as NUL-ended tokens, the first after a newline. A NUL occurs in no message or path, and a path token is
 * never empty, so only a header follows an empty token: neither a message nor a path can forge or hide a record.
 */
export const LOG_ARGS: readonly string[] = ["-z", "--format=%x00%x1e%H%x1f%ct%x1f%ae%x1f%B"];

/** One commit record of `git log` output of LOG_ARGS (in memory only). */
export interface LogRecord { sha: string; ct: number; email: string; message: string; files: string[] }

/**
 * The records of `git log` output of LOG_ARGS (all authors'). A header (an empty token, then one starting `\x1e`) must
 * hold at least four fields with a hex sha and a numeric time; one that does not is left out with the paths after it.
 * `cut`: the output was cut short, so its last record (possibly incomplete) is left out.
 */
export function logRecords(stdout: string, o: { cut?: boolean } = {}): LogRecord[] {
  const out: LogRecord[] = [];
  let cur: LogRecord | undefined;
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (i > 0 && tokens[i - 1] === "" && token.startsWith(HEAD)) {
      const fields = token.slice(1).split(FIELD);
      const sha = fields[0] ?? "";
      const ct = Number(fields[1]);
      const valid = fields.length >= 4 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha) && fields[1] !== "" && Number.isFinite(ct);
      cur = valid ? { sha, ct, email: fields[2]!, message: fields.slice(3).join(FIELD), files: [] } : undefined;
      if (cur) out.push(cur);
    } else if (cur) {
      cur.files.push(token.replace(/^\n/, ""));
    }
  }
  if (o.cut) out.pop();
  return out;
}

/** A commit of the person's as keyed facts, with its full sha (memory only, for the pass: never stored). */
export interface ParsedCommit { fact: CommitFact; sha: string }

/**
 * The person's commits in `git log` output of LOG_ARGS: only those whose author email equals `o.email`
 * (case-insensitively); each as keyed facts — `ts` = commit time in ms, `shaKey`, the trailers `classifyCommit` reads,
 * up to `o.maxFiles` changed paths as keyed hashes, and `owner` true (a later pass decides between repos). `cut` as for
 * `logRecords`.
 */
export function parseCommits(stdout: string, o: { salt: Uint8Array; email: string; maxFiles: number; cut?: boolean }): ParsedCommit[] {
  const email = o.email.trim().toLowerCase();
  return logRecords(stdout, { cut: o.cut })
    .filter((r) => r.email.trim().toLowerCase() === email)
    .map((r) => ({ sha: r.sha.toLowerCase(), fact: { ts: r.ct * 1000, shaKey: shaKey(o.salt, r.sha), ...classifyCommit(r.message),
      files: r.files.slice(0, o.maxFiles).map((f) => keyedHash(o.salt, f)), owner: true } }));
}

/** `parseCommits` without the shas: the facts only. */
export const parseLog = (stdout: string, o: { salt: Uint8Array; email: string; maxFiles: number; cut?: boolean }): CommitFact[] =>
  parseCommits(stdout, o).map((c) => c.fact);
