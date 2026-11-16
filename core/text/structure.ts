import type { PromptFeatures } from "../model/events";
import { wordCount } from "./intent";
import { shingleSimilarity } from "./similarity";
import { techCategories } from "./tech";

const RE_FILE = /[\w.-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb|php|cs|c|cpp|h|css|scss|html|json|ya?ml|toml|md|sql|sh|env|swift|kt|vue|svelte)\b/i;
const RE_PATH = /^[~.]?\/[\w@./-]{3,}|\b[\w.-]+\/[\w.-]+\/[\w./-]+/;
const RE_LIST = /^\s*([-*•]|\d+[.)])\s/;
const RE_CONSTRAINT = /\b(must|should|don'?t|do not|avoid|ensure|verify|make sure|instead|because|so that|expected|constraint|require[sd]?|keep|only|never|always)\b/gi;
const RE_CONTEXT = /```|\bTraceback\b|\b\w*Error:|\bException\b|\bstack trace\b|^\s+at\s+\w/m;

function lenBucket(words: number): 0 | 1 | 2 | 3 | 4 {
  return words <= 4 ? 0 : words <= 19 ? 1 : words <= 59 ? 2 : words <= 199 ? 3 : 4;
}

function countFileRefs(text: string): number {
  let n = 0;
  for (const raw of text.split(/\s+/)) {
    const tok = raw.replace(/^[("'`[<]+|[)"'`\]>,;:!?]+$/g, "");
    if (!tok || tok.includes("://")) continue;
    if (RE_FILE.test(tok) || RE_PATH.test(tok)) n++;
  }
  return n;
}

export function promptFeatures(text: string, o: { hasPaste?: boolean; isTaskStart?: boolean; prevText?: string } = {}): PromptFeatures {
  const words = wordCount(text);
  const f: PromptFeatures = {
    words,
    lenBucket: lenBucket(words),
    hasContext: RE_CONTEXT.test(text) || (o.hasPaste ?? false),
    fileRefs: countFileRefs(text),
    listLines: text.split("\n").filter((l) => RE_LIST.test(l)).length,
    constraintTerms: (text.match(RE_CONSTRAINT) ?? []).length,
    isTaskStart: o.isTaskStart ?? false,
    techCats: techCategories(text),
  };
  if (typeof o.prevText === "string") f.simToPrev = shingleSimilarity(text, o.prevText);
  return f;
}
