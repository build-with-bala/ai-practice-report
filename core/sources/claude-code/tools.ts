import type { CheckKind, ToolCategory, Toolchain } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { extOfPath, isObj } from "../common/guards";

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
  // bookkeeping and talk with the person: asking the person, looking up the deferred tools
  ["AskUserQuestion", "meta"], ["ToolSearch", "meta"],
]);
/** Tools whose `input.command` is a shell command line (PowerShell is the Windows counterpart of Bash). */
export const SHELL = new Set(["Bash", "PowerShell"]);
/**
 * The CLI's other built-in tools (CLI program: its own list of built-in tool names, and older names it still knows): no
 * category of their own (`other`), but a built-in name, so a tool event keeps it. FORMAT.md lists them.
 */
const OTHER_BUILTINS = [
  "Artifact", "ArtifactCheck", "ArtifactComments", "ArtifactData", "BashOutput", "ClaudeDesign", "CronDelete", "CronList",
  "EndConversation", "EnterWorktree", "ExitWorktree", "ListAgents", "ListMcpResourcesTool", "LSP", "NotebookRead", "OfferChromeSetup",
  "Projects", "propose_skills", "PushNotification", "ReadMcpResourceDirTool", "ReadMcpResourceTool", "ReadNotifications", "RemoteTrigger",
  "ReportFindings", "SendFeedback", "SendMessage", "SendUserFile", "SendUserMessage", "SetGoal", "ShareOnboardingGuide",
  "ShowOnboardingRolePicker", "SubagentHandback", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "WaitForMcpServers",
];
/**
 * The tool names a ToolEv keeps (any other name becomes `other`, so a name the person chose never leaves as a tool
 * name): every name `ccToolCategory` maps, and the CLI's other built-in tools.
 */
export const CC_BUILTIN_TOOLS: ReadonlySet<string> = new Set([...FIXED.keys(), ...SHELL, ...OTHER_BUILTINS]);
/** Agent types the CLI ships; any other agent type is a config name and is kept only as a keyed hash. */
export const BUILTIN_AGENTS: ReadonlySet<string> = new Set([
  "general-purpose", "Explore", "Plan", "claude", "fork", "statusline-setup", "output-style-setup", "claude-code-guide",
  "comment-thread-analyst", "workflow-subagent",
]);
const MCP = /^mcp__(.+?)__(.+)$/;

/** Server part of an `mcp__<server>__<tool>` name; undefined for any other tool. */
export function mcpServerOf(name: string): string | undefined {
  return MCP.exec(name)?.[1];
}

/** Lower-case extension of the edited file (`file_path`, or `notebook_path` for notebooks); dotfiles have none. */
function extOf(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
  return p === undefined ? undefined : extOfPath(p);
}

/** A tool call's category and checks — a shell call's by its command line, with that command's toolchain — and an edit's extension. */
export function ccToolCategory(name: string, input: unknown): { category: ToolCategory; checks: CheckKind[]; editExt?: string; toolchain?: Toolchain } {
  if (SHELL.has(name)) return classifyCommand(isObj(input) && typeof input.command === "string" ? input.command : "");
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
