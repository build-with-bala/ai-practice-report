/*
 * Model tiers, effort ranks and child types: the scales Judgment's tier-vs-task-size correlation and the orchestration
 * panel read (walk rules 13 and 15).
 */

/** What a subagent or child thread was for, from its `agentType`. */
export type ChildType = "explore" | "plan" | "review" | "implement" | "custom" | "other";

const TIER_1 = new Set(["haiku", "mini", "nano", "small"]);
const TIER_2 = new Set(["sonnet", "flash", "standard", "codex"]);
const TIER_3 = new Set(["opus", "max", "pro", "ultra", "large"]);

/**
 * A model's tier, from the words of its id (split on anything that is not a letter or digit, so `gemini` is no `mini`):
 * 1 = haiku, mini, nano, flash-lite, small; 3 = opus, max, pro, ultra, large; 2 = sonnet, flash, standard, `gpt-<N>`
 * and `codex` without a tier-1 or tier-3 word. Tier 1 is tested first (`codex-mini` is 1), then tier 3 (`codex-max`
 * is 3). Undefined for a model none of these name.
 */
export function modelTier(model: string): 1 | 2 | 3 | undefined {
  const s = model.toLowerCase();
  const words = s.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (set: ReadonlySet<string>) => words.some((w) => set.has(w));
  if (has(TIER_1) || /(^|[^a-z0-9])flash-lite($|[^a-z0-9])/.test(s)) return 1;
  if (has(TIER_3)) return 3;
  if (has(TIER_2) || /(^|[^a-z0-9])gpt-\d/.test(s)) return 2;
  return undefined;
}

const EFFORT: ReadonlyMap<string, 1 | 2 | 3 | 4> = new Map([
  ["none", 1], ["minimal", 1], ["low", 1], ["medium", 2], ["high", 3], ["xhigh", 4], ["max", 4], ["ultra", 4],
]);

/** A reasoning effort's rank: none, minimal, low 1; medium 2; high 3; xhigh, max, ultra 4; undefined for any other. */
export function effortRank(effort: string): 1 | 2 | 3 | 4 | undefined {
  return EFFORT.get(effort.toLowerCase());
}

const IMPLEMENT = /^(general-purpose|claude|fork|default|workflow-subagent)$/i;
/** A keyed hash (a custom agent's name, hashed by its reader): 16 lowercase hex digits. */
const KEYED = /^[0-9a-f]{16}$/;

/**
 * A child's type from its `agentType`: `explore(r)` explore; `plan` plan; any name with `review` review; the built-in
 * general agents (general-purpose, claude, fork, default, workflow-subagent) implement; a keyed hash (a custom agent)
 * custom; anything else, or none, other.
 */
export function childType(agentType: string | undefined): ChildType {
  if (agentType === undefined) return "other";
  if (/^explorer?$/i.test(agentType)) return "explore";
  if (/^plan$/i.test(agentType)) return "plan";
  if (/review/i.test(agentType)) return "review";
  if (IMPLEMENT.test(agentType)) return "implement";
  if (KEYED.test(agentType)) return "custom";
  return "other";
}
