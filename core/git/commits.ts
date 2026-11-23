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
const CO_AUTHOR = /^\s*co-authored-by:(.*)$/gim;
const TOOL_WORDS: readonly [AiTool, RegExp][] = TOOLS.map(([tool, p]) => [tool, new RegExp(`\\b(?:${p})\\b`, "i")]);
const GENERATED: readonly [AiTool, RegExp][] = TOOLS.map(([tool, p]) => [tool, new RegExp(`generated (?:with|by) \\[?(?:${p})\\b`, "i")]);

/** The first tool whose pattern a text matches. */
const toolIn = (text: string, list: readonly [AiTool, RegExp][]): AiTool | undefined => list.find(([, re]) => re.test(text))?.[0];

/**
 * What a commit message says, in memory only (the message is dropped): `ai`, the AI tool of its first `Co-authored-by:`
 * trailer that names one (other co-authors are ignored); `generated`, the tool of a "Generated with/by [tool" line;
 * `rework`, from the subject — `Revert "…` (revert), `fixup! `/`squash! `/`amend! ` (fixup), `fix:`/`hotfix:`/
 * `bugfix:` with an optional scope and `!` (fix).
 */
export function classifyCommit(message: string): Pick<CommitFact, "ai" | "generated" | "rework"> {
  const out: Pick<CommitFact, "ai" | "generated" | "rework"> = {};
  for (const m of message.matchAll(CO_AUTHOR)) {
    const tool = toolIn(m[1]!, TOOL_WORDS);
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

const RECORD = "\x1e";
const FIELD = "\x1f";

/** Records in `git log` output of the format `%x1e%H%x1f%ct%x1f%ae%x1f%B%x1f` (then `--name-only` paths, if asked for). */
export const LOG_FORMAT = "--format=%x1e%H%x1f%ct%x1f%ae%x1f%B%x1f";

/** The number of commit records in `git log` output of LOG_FORMAT (all authors'). */
export const logRecords = (stdout: string): number => stdout.split(RECORD).length - 1;

/**
 * The person's commits in `git log` output of LOG_FORMAT: only those whose author email equals `o.email`
 * (case-insensitively); each as keyed facts — `ts` = commit time in ms, `shaKey`, the trailers `classifyCommit` reads,
 * and up to `o.maxFiles` changed paths as keyed hashes. A record cut short (output capped) or without a sha is left out.
 */
export function parseLog(stdout: string, o: { salt: Uint8Array; email: string; maxFiles: number }): CommitFact[] {
  const email = o.email.trim().toLowerCase();
  const out: CommitFact[] = [];
  for (const record of stdout.split(RECORD).slice(1)) {
    const fields = record.split(FIELD);
    if (fields.length < 5) continue; // cut short
    const sha = fields[0]!;
    const ct = Number(fields[1]);
    if (!/^[0-9a-f]{7,}$/i.test(sha) || !Number.isFinite(ct)) continue;
    if (fields[2]!.trim().toLowerCase() !== email) continue;
    const message = fields.slice(3, -1).join(FIELD);
    const files = fields.at(-1)!.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "").slice(0, o.maxFiles);
    out.push({ ts: ct * 1000, shaKey: shaKey(o.salt, sha), ...classifyCommit(message), files: files.map((f) => keyedHash(o.salt, f)) });
  }
  return out;
}
