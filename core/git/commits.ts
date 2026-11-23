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
 * Words of TOOLS that are also people's names or plain words (Claude, Jules, Devin, Amp, …). In a co-author trailer such
 * a word names the AI tool only with a sign that the co-author is no person: `[bot]` in the name, a `noreply`/`no-reply`
 * address, or an address at one of the tool's vendor domains (listed here). The other words are product names and
 * count wherever they stand as whole words.
 */
const NAME_LIKE: Readonly<Record<string, readonly string[]>> = {
  claude: ["anthropic.com", "claude.com", "claude.ai"],
  jules: ["google.com"],
  devin: ["devin.ai", "cognition.ai", "cognition-labs.com"],
  amp: ["ampcode.com", "sourcegraph.com"],
  factory: ["factory.ai"],
  droid: ["factory.ai"],
  kiro: ["kiro.dev", "amazon.com"],
  cline: ["cline.bot"],
  roo: ["roocode.com"],
  kilo: ["kilocode.ai"],
  goose: ["block.xyz"],
  crush: ["charm.sh"],
  junie: ["jetbrains.com"],
};
const CO_AUTHOR = /^\s*co-authored-by:(.*)$/gim;
const GENERATED: readonly [AiTool, RegExp][] = TOOLS.map(([tool, p]) => [tool, new RegExp(`generated (?:with|by) \\[?(?:${p})\\b`, "i")]);
const WORDS: readonly [AiTool, string][] = TOOLS.flatMap(([tool, p]) => p.split("|").map((w): [AiTool, string] => [tool, w]));

/** A co-author is no person: `[bot]` in its name, or a no-reply address (a person's GitHub no-reply address aside). */
function botSigns(trailer: string): { bot: boolean; domain?: string } {
  const email = /<([^<>@\s]+)@([^<>\s]+)>/.exec(trailer);
  const domain = email?.[2]?.toLowerCase();
  const noreply = email !== null && /^no-?reply$/i.test(email[1]!) && domain !== "users.noreply.github.com";
  return { bot: /\[bot\]/i.test(trailer) || noreply, domain };
}

/** The AI tool a co-author trailer (`Name <email>`) names, by the first word of WORDS it holds that counts there. */
function coAuthorTool(trailer: string): AiTool | undefined {
  const signs = botSigns(trailer);
  for (const [tool, word] of WORDS) {
    if (!new RegExp(`\\b${word}\\b`, "i").test(trailer)) continue;
    const vendors = NAME_LIKE[word];
    if (vendors === undefined) return tool;
    if (signs.bot || (signs.domain !== undefined && vendors.some((v) => signs.domain === v || signs.domain!.endsWith(`.${v}`)))) return tool;
  }
  return undefined;
}

/** The first tool whose pattern a text matches. */
const toolIn = (text: string, list: readonly [AiTool, RegExp][]): AiTool | undefined => list.find(([, re]) => re.test(text))?.[0];

/**
 * What a commit message says, in memory only (the message is dropped): `ai`, the AI tool of its first `Co-authored-by:`
 * trailer that names one (people are ignored, a person named like a tool included: see NAME_LIKE); `generated`, the
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
 * `git log -z` with this format: each commit is a NUL-ended token `\x1e<sha>\x1f<commit time>\x1f<author email>\x1f<message>`;
 * with `--name-only`, its changed paths follow as NUL-ended tokens, the first after a newline. A NUL never occurs in a
 * message or a path, so a message cannot forge or hide a record.
 */
export const LOG_ARGS: readonly string[] = ["-z", "--format=%x1e%H%x1f%ct%x1f%ae%x1f%B"];

/** One commit record of `git log` output of LOG_ARGS (in memory only). */
export interface LogRecord { sha: string; ct: number; email: string; message: string; files: string[] }

/**
 * The records of `git log` output of LOG_ARGS (all authors'). A token that starts a record must hold at least four fields
 * with a hex sha and a numeric time; one that does not is left out with the paths after it. `cut`: the output was cut
 * short, so its last record (possibly incomplete) is left out.
 */
export function logRecords(stdout: string, o: { cut?: boolean } = {}): LogRecord[] {
  const out: LogRecord[] = [];
  let cur: LogRecord | undefined;
  let valid = false;
  const tokens = stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop(); // after the last NUL
  for (const token of tokens) {
    if (token.startsWith(HEAD)) {
      const fields = token.slice(1).split(FIELD);
      const sha = fields[0] ?? "";
      const ct = Number(fields[1]);
      valid = fields.length >= 4 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha) && fields[1] !== "" && Number.isFinite(ct);
      cur = valid ? { sha, ct, email: fields[2]!, message: fields.slice(3).join(FIELD), files: [] } : undefined;
      if (cur) out.push(cur);
    } else if (cur && valid) {
      const file = token.replace(/^\n/, "");
      if (file !== "") cur.files.push(file);
    }
  }
  if (o.cut) out.pop();
  return out;
}

/**
 * The person's commits in `git log` output of LOG_ARGS: only those whose author email equals `o.email`
 * (case-insensitively); each as keyed facts — `ts` = commit time in ms, `shaKey`, the trailers `classifyCommit` reads,
 * and up to `o.maxFiles` changed paths as keyed hashes. `cut` as for `logRecords`.
 */
export function parseLog(stdout: string, o: { salt: Uint8Array; email: string; maxFiles: number; cut?: boolean }): CommitFact[] {
  const email = o.email.trim().toLowerCase();
  return logRecords(stdout, { cut: o.cut })
    .filter((r) => r.email.trim().toLowerCase() === email)
    .map((r) => ({ ts: r.ct * 1000, shaKey: shaKey(o.salt, r.sha), ...classifyCommit(r.message),
      files: r.files.slice(0, o.maxFiles).map((f) => keyedHash(o.salt, f)) }));
}
