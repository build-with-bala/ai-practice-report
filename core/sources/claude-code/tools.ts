import type { CheckKind, ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";

/** Built-in Claude Code tools with a fixed category (shell tools and MCP tools are classified separately). */
const FIXED = new Map<string, ToolCategory>([
  ["Read", "read"],
  ["Grep", "search"], ["Glob", "search"],
  ["Edit", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"],
  ["Write", "write"],
  ["Agent", "delegate"], ["Task", "delegate"],
  ["Workflow", "workflow"],
  ["TodoWrite", "todo"], ["TaskCreate", "todo"], ["TaskUpdate", "todo"],
  ["EnterPlanMode", "plan"], ["ExitPlanMode", "plan"],
  ["WebFetch", "web"], ["WebSearch", "web"],
  ["Skill", "skill"],
  ["Monitor", "monitor"],
  ["CronCreate", "schedule"], ["ScheduleWakeup", "schedule"],
]);
/** Tools whose `input.command` is a shell command line (PowerShell is the Windows counterpart of Bash). */
const SHELL = new Set(["Bash", "PowerShell"]);
const MCP = /^mcp__(.+?)__(.+)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Server part of an `mcp__<server>__<tool>` name; undefined for any other tool. */
export function mcpServerOf(name: string): string | undefined {
  return MCP.exec(name)?.[1];
}

/** Lower-case extension of the edited file (`file_path`, or `notebook_path` for notebooks); dotfiles have none. */
function extOf(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
  if (p === undefined) return undefined;
  const base = p.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : undefined;
}

export function ccToolCategory(name: string, input: unknown): { category: ToolCategory; checks: CheckKind[]; editExt?: string } {
  if (SHELL.has(name)) {
    const cmd = isObj(input) && typeof input.command === "string" ? input.command : "";
    const { category, checks } = classifyCommand(cmd);
    return { category, checks };
  }
  if (mcpServerOf(name) !== undefined) return { category: "mcp", checks: [] };
  const category = FIXED.get(name) ?? "other";
  const out: { category: ToolCategory; checks: CheckKind[]; editExt?: string } = { category, checks: [] };
  if (category === "edit" || category === "write") {
    const ext = extOf(input);
    if (ext !== undefined) out.editExt = ext;
  }
  return out;
}

/** Added/removed line counts of a `toolUseResult.structuredPatch` (hunks of "+", "-" and " " prefixed lines). */
export function patchLines(patch: unknown): { added: number; removed: number } | undefined {
  if (!Array.isArray(patch) || patch.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}
