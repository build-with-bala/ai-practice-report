export type ToolId = "claude-code" | "codex" | "copilot" | "cursor" | "antigravity"
  | "gemini-cli" | "opencode" | "cline" | "roo-code" | "kilo-code"
  | "windsurf" | "zed" | "kiro" | "warp" | "amp" | "goose" | "droid" | "qwen-code" | "crush" | "aider" | "continue" | "jetbrains-ai";
export type Tier = "P0" | "P1" | "P2";
export type Window = "detail" | "lifetime";
export type Origin = "human" | "scripted" | "subagent" | "scheduled" | "peer" | "system";
export type Intent = "spec" | "question" | "ack" | "correction" | "redirect" | "command" | "continuation";
export type CheckKind = "test" | "build" | "lint" | "typecheck";
/**
 * What a tool call does. `meta` = bookkeeping and talk with the person, no work on the task itself: thinking aloud,
 * asking or notifying the person, reporting progress, intent or completion, switching modes, reading the clock,
 * waiting, finishing — counted apart from actions, the same way for every tool.
 */
export type ToolCategory = "read" | "search" | "edit" | "write" | "shell" | "test" | "build" | "lint" | "typecheck"
  | "git" | "package" | "container" | "db" | "network" | "cloud" | "browser" | "web" | "mcp" | "delegate"
  | "workflow" | "plan" | "todo" | "notebook" | "schedule" | "monitor" | "skill" | "meta" | "other";
export type TechCategory = "data" | "infra" | "security" | "testing" | "ai" | "architecture" | "frontend" | "mobile" | "systems";
export type MarkerKind = "interrupt" | "compact-auto" | "compact-manual" | "clear" | "plan-enter" | "plan-exit" | "plan-artifact"
  | "queue" | "pr-link" | "commit" | "denial" | "model-switch" | "effort-switch" | "permission-mode" | "error";

export function sid(tool: ToolId, raw: string): string {
  return `${tool}:${raw}`;
}
