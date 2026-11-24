import type { ToolId } from "../model/ids";
import type { Exclusions } from "./types";

/** The closed tool list: an exclusion may name only these. */
const TOOLS: Record<ToolId, true> = {
  "claude-code": true, codex: true, copilot: true, cursor: true, antigravity: true, "gemini-cli": true, opencode: true, cline: true,
  "roo-code": true, "kilo-code": true, windsurf: true, zed: true, kiro: true, warp: true, amp: true, goose: true, droid: true,
  "qwen-code": true, crush: true, aider: true, continue: true, "jetbrains-ai": true,
};
export const TOOL_IDS: readonly ToolId[] = Object.freeze(Object.keys(TOOLS) as ToolId[]);
const isTool = (v: unknown): v is ToolId => typeof v === "string" && Object.hasOwn(TOOLS, v);

/** A project label: "P-" and 4, 6, … 16 upper-case hex digits. */
export const LABEL_SHAPE = /^P-(?:[0-9A-F]{2}){2,8}$/;
/** A keyed hash as the engine makes it: 16 lower-case hex digits. */
const KEY_SHAPE = /^[0-9a-f]{16}$/;

/** The option an `ExclusionError` names. */
export type ExclusionOption = "tools" | "projects" | "from" | "to";

const WHAT: Record<ExclusionOption, string> = {
  tools: "the tool exclusion", projects: "the project exclusion", from: "the date range's start", to: "the date range's end",
};

/**
 * An exclusion that cannot be honoured exactly: an unknown tool, a project that names no label or key, a date-range end
 * that is not a finite epoch-ms time, or a start later than the end. It names the option; it quotes the entry only when
 * the entry has exactly the shape of a project label or a keyed hash, or is a known tool, so a typed folder or project
 * name never reaches a message.
 */
export class ExclusionError extends RangeError {
  override readonly name = "ExclusionError";
  readonly option: ExclusionOption;
  constructor(option: ExclusionOption, problem: string, entry?: unknown) {
    const shown = typeof entry === "string" && (LABEL_SHAPE.test(entry) || KEY_SHAPE.test(entry) || isTool(entry)) ? ` "${entry}"` : "";
    super(`analyze: ${WHAT[option]}${shown} ${problem}`);
    this.option = option;
  }
}

/**
 * Checks the exclusions before anything is left out, so a typo never silently excludes nothing: every tool must be in
 * the closed tool list, every project entry a string, `from` and `to` (when given) finite numbers, and `from` no later
 * than `to`. Throws `ExclusionError`; the project entries are resolved (and fail closed) by `analyze`.
 */
export function checkExclusions(ex: Exclusions | undefined): void {
  if (ex === undefined) return;
  const tools: unknown = ex.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new ExclusionError("tools", "is not a list of tools");
    for (const t of tools) if (!isTool(t)) throw new ExclusionError("tools", "names no known tool", t);
  }
  const projects: unknown = ex.projects;
  if (projects !== undefined) {
    if (!Array.isArray(projects)) throw new ExclusionError("projects", "is not a list of projects");
    for (const p of projects) if (typeof p !== "string") throw new ExclusionError("projects", "is not a project label or key");
  }
  for (const k of ["from", "to"] as const) {
    const v: unknown = ex[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new ExclusionError(k, "is not a finite epoch-ms time");
  }
  if (ex.from !== undefined && ex.to !== undefined && ex.from > ex.to) throw new ExclusionError("from", "is later than the date range's end");
}
