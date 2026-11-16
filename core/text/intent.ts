import type { Intent } from "../model/ids";

const RE_CORRECTION = /^(no|nope|wrong|that'?s (not|wrong)|not (what|quite)|revert|undo|still (broken|failing|wrong)|(doesn|didn)'?t work|you (broke|missed))\b/i;
const RE_REDIRECT = /^(actually|instead|wait|stop|hold on|scratch that|change of plan|rather|let'?s (not|instead))\b/i;
const RE_CONTINUATION = /^(continue|go on|keep going|carry on|proceed|next|resume|go ahead)\b/i;
const RE_ACK = /^(ok(ay)?|thanks?|thank you|ty|yes|yep|sure|great|perfect|nice|lgtm|approved?|looks good|do it|ship it|go|cool)\b/i;
const RE_QUESTION_START = /^(what|why|how|when|where|which|who|can|could|should|would|is|are|does|do|did)\b/i;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Classify a prompt's intent from its text. Precedence is fixed; empty text is an ack. */
export function classifyIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return "ack";
  if (t.startsWith("/") || t.startsWith("!")) return "command";
  // "first words": anchor at the start after stripping leading punctuation/quotes.
  const head = t.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  const words = wordCount(t);
  if (words <= 40 && RE_CORRECTION.test(head)) return "correction";
  if (RE_REDIRECT.test(head)) return "redirect";
  if (words <= 6 && RE_CONTINUATION.test(head)) return "continuation";
  if (words <= 6 && RE_ACK.test(head)) return "ack";
  if (t.endsWith("?") || (words <= 40 && RE_QUESTION_START.test(head))) return "question";
  return "spec";
}
