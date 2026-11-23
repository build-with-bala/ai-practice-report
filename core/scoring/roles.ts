import type { Stack, StackRole } from "../analysis/panels";
import type { TechCategory } from "../model/ids";
import type { DimensionId } from "./dimensions";
import type { DimensionResult } from "./score";

/** The role each dimension names when it is strong (spec §6.5 personas). */
export const PRACTICE_ROLES: Readonly<Record<DimensionId, string>> = Object.freeze({
  leverage: "Force multiplier", orchestration: "Orchestrator", verification: "QA", steering: "Navigator",
  context: "Context engineer", judgment: "Right-sizer", delivery: "Shipper",
});
/** The role each stack role names. */
export const STACK_ROLES: Readonly<Record<StackRole | "ai", string>> = Object.freeze({
  frontend: "Frontend", backend: "Backend", mobile: "Mobile", data: "Data", ai: "AI engineer",
});

const MAX_ROLES = 3;
/** A practice role needs a scored dimension at medium or high confidence with at least this score. */
const MIN_SCORE = 60;
/** A stack role needs at least this many code edits… */
const MIN_EDITS = 50;
/** …making at least this share (a quarter) of all code edits. */
const MIN_SHARE = 0.25;
/** AI engineer needs `ai` to be the largest tech category with at least this many prompts. */
const MIN_AI_PROMPTS = 30;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const count = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The top-3 role names (spec §6.5 personas: names only, no "% match"): first the strongest eligible stack role, if
 * any, then the eligible practice roles by shown z (`DimensionResult.z`), highest first; ties break by role name.
 * - Practice: the dimension is scored at medium or high confidence with a score of at least 60.
 * - Stack: an edit role's code edits (`Stack.roleEdits`) are at least 50 and at least 25% of all code edits (every
 *   language but `doc`); AI engineer: `techCategories.ai` is at least 30 and no other category is larger. Strength is
 *   the share (an edit role's of the code edits; AI's of the tech-category prompts).
 */
export function roles(dims: readonly DimensionResult[], stack: Stack): string[] {
  const out: string[] = [];
  const codeEdits = Object.entries(stack.languages).reduce((s, [lang, n]) => (lang === "doc" ? s : s + count(n)), 0);
  const stackRoles: { name: string; share: number }[] = [];
  for (const role of Object.keys(stack.roleEdits) as StackRole[]) {
    const n = count(stack.roleEdits[role]);
    if (n >= MIN_EDITS && codeEdits > 0 && n >= MIN_SHARE * codeEdits) stackRoles.push({ name: STACK_ROLES[role], share: n / codeEdits });
  }
  const cats = Object.entries(stack.techCategories) as [TechCategory, number][];
  const ai = count(stack.techCategories.ai);
  const techTotal = cats.reduce((s, [, n]) => s + count(n), 0);
  if (ai >= MIN_AI_PROMPTS && cats.every(([, n]) => count(n) <= ai)) stackRoles.push({ name: STACK_ROLES.ai, share: ai / techTotal });
  stackRoles.sort((a, b) => b.share - a.share || cmp(a.name, b.name));
  if (stackRoles[0]) out.push(stackRoles[0].name);

  const practice = dims
    .filter((d) => d.status === "scored" && (d.confidence === "medium" || d.confidence === "high") && d.score !== null && d.score >= MIN_SCORE
      && d.z !== null && Number.isFinite(d.z))
    .map((d) => ({ name: PRACTICE_ROLES[d.id], z: d.z! }))
    .sort((a, b) => b.z - a.z || cmp(a.name, b.name));
  for (const p of practice) {
    if (out.length >= MAX_ROLES) break;
    if (!out.includes(p.name)) out.push(p.name);
  }
  return out;
}
