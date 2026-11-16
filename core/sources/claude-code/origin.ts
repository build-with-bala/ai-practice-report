import type { Origin } from "../../model/ids";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const INTERRUPT = "[Request interrupted";
/** Wrappers the CLI puts around command output it records as user messages: output, never input. */
const OUTPUT_TAG = /^<(?:local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr))>/;

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
 * "not-a-prompt". Exclusions win over the human signals: `entrypoint:"sdk-cli"` → scripted, then non-human
 * `turnOrigin`s, then text not typed by a person; human = `turnOrigin:"human"` or `promptSource` ∈ {typed,
 * queued, suggestion_accepted}. When neither field says anything usable (older CLIs), typed text that starts
 * with "<" or "[" is machine text (system), anything else is human.
 */
export function ccPromptOrigin(rec: unknown): Origin | "not-a-prompt" {
  if (!isObj(rec) || rec.type !== "user") return "not-a-prompt";
  if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true || rec.turnCompanion === true
    || rec.isVirtual === true || typeof rec.sourceToolUseID === "string") return "not-a-prompt";
  const raw = userText(rec);
  if (raw === undefined || raw.trim() === "") return "not-a-prompt";
  const lead = raw.trimStart();
  if (lead.startsWith(INTERRUPT) || OUTPUT_TAG.test(lead)) return "not-a-prompt";

  if (rec.entrypoint === "sdk-cli") return "scripted";
  switch (rec.turnOrigin) {
    case "sdk": return "scripted";
    case "peer": return "peer";
    case "scheduled": return "scheduled";
    case "task_notification": case "auto_continuation": case "host_synthetic": case "system": return "system";
    default: break;
  }
  if (rec.textNotTyped === true || rec.handedOff === true) return "system";
  if (rec.turnOrigin === "human") return "human";
  switch (rec.promptSource) {
    case "typed": case "queued": case "suggestion_accepted": return "human";
    case "sdk": return "scripted";
    case "system": return "system";
    default: break;
  }
  return /^[<[]/.test(typedText(raw).trimStart()) ? "system" : "human";
}
