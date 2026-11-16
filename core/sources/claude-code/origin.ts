import type { Origin } from "../../model/ids";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const INTERRUPT = "[Request interrupted";
/** Wrappers the CLI puts around command output it records as user messages: output, never input. */
const OUTPUT_TAG = /^<(?:local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr))>/;

/** The provenance values this mapping knows. Anything else (including the CLI's own `unknown`) is not human. */
const TURN_ORIGINS: ReadonlyMap<string, Origin> = new Map<string, Origin>([
  ["human", "human"], ["sdk", "scripted"], ["peer", "peer"], ["scheduled", "scheduled"],
  ["task_notification", "system"], ["auto_continuation", "system"], ["host_synthetic", "system"], ["system", "system"],
]);
const PROMPT_SOURCES: ReadonlyMap<string, Origin> = new Map<string, Origin>([
  ["typed", "human"], ["queued", "human"], ["suggestion_accepted", "human"], ["sdk", "scripted"], ["system", "system"],
]);
const VALUE_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

const known = (map: ReadonlyMap<string, Origin>, v: unknown): Origin | undefined => (typeof v === "string" ? map.get(v) : undefined);

/**
 * Provenance values present on a record that the mapping does not know, as coverage keys:
 * `turnOrigin:<value>` / `promptSource:<value>` when the value is token-shaped, else `…:<other>`.
 */
export function unknownProvenance(rec: Obj): string[] {
  const out: string[] = [];
  for (const [field, map] of [["turnOrigin", TURN_ORIGINS], ["promptSource", PROMPT_SOURCES]] as const) {
    const v = rec[field];
    if (v === undefined || known(map, v) !== undefined) continue;
    out.push(`${field}:${typeof v === "string" && VALUE_TOKEN.test(v) ? v : "<other>"}`);
  }
  return out;
}

/**
 * Text of a user record: string content, or its text blocks joined by "\n".
 * Undefined when the record carries a tool_result (it is a tool reply) or no text.
 */
export function userText(rec: Obj): string | undefined {
  const content = isObj(rec.message) ? rec.message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "tool_result") return undefined;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function isInterrupt(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT);
}

/**
 * What the person typed, recovered from the CLI's wrappers: a skill/custom slash command is stored as
 * `<command-message>…</command-message><command-name>/x</command-name><command-args>a</command-args>` → "/x a",
 * bash mode as `<bash-input>c</bash-input>` → "!c". Anything else is returned unchanged.
 */
export function typedText(raw: string): string {
  const t = raw.trimStart();
  if (t.startsWith("<command-")) {
    const name = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(t)?.[1];
    if (name) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
      return args ? `/${name} ${args}` : `/${name}`;
    }
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
  return bash ? `!${bash[1]}` : raw;
}

/**
 * Who authored a transcript record as a prompt. Machine-inserted user records (meta, compaction summaries,
 * tool-generated companions, virtual/unsent messages, command output, interrupt notices, tool replies) are
 * "not-a-prompt". Exclusions win over the human signals: an SDK `entrypoint` (`sdk-cli`, `sdk-ts`, `sdk-py`, …) →
 * scripted, then non-human `turnOrigin`s, then text not typed by a person, then any provenance value this mapping
 * does not know (→ system; see `unknownProvenance`). Human = `turnOrigin:"human"` or `promptSource` ∈ {typed,
 * queued, suggestion_accepted}. Only when both fields are absent (older CLIs) is the text consulted: typed text that
 * starts with "<" or "[" is machine text (system), anything else is human.
 */
export function ccPromptOrigin(rec: unknown): Origin | "not-a-prompt" {
  if (!isObj(rec) || rec.type !== "user") return "not-a-prompt";
  if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true || rec.turnCompanion === true
    || rec.isVirtual === true || typeof rec.sourceToolUseID === "string") return "not-a-prompt";
  const raw = userText(rec);
  if (raw === undefined || raw.trim() === "") return "not-a-prompt";
  const lead = raw.trimStart();
  if (lead.startsWith(INTERRUPT) || OUTPUT_TAG.test(lead)) return "not-a-prompt";

  if (typeof rec.entrypoint === "string" && rec.entrypoint.startsWith("sdk")) return "scripted";
  const turn = known(TURN_ORIGINS, rec.turnOrigin);
  if (turn !== undefined && turn !== "human") return turn;
  if (rec.textNotTyped === true || rec.handedOff === true) return "system";
  if (unknownProvenance(rec).length > 0) return "system";
  if (turn === "human") return "human";
  const source = known(PROMPT_SOURCES, rec.promptSource);
  if (source !== undefined) return source;
  return /^[<[]/.test(typedText(raw).trimStart()) ? "system" : "human"; // both fields absent
}
