import type { CheckKind, ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { extOfPath, isObj, num, str } from "../common/guards";

/**
 * One tool action: per call, or per file for patches. Names are the CLI's built-in tool names, `mcp`, or `other`.
 * `commandLine` is set on shell commands only: whether a command line was found to classify (never on other actions).
 */
export interface CxToolCall { name: string; category: ToolCategory; checks: CheckKind[]; editExt?: string; added?: number; removed?: number; mcpServer?: string;
  commandLine?: boolean }
/** How an action ended, from the item that completed it: `denied` when the person declined it (it never ran). */
export interface CxOutcome { ok?: boolean; exit?: number; ms?: number; outcome?: "denied" }

/** Built-in tools with a fixed category (the CLI's tool handlers, 0.169). Shell, patch and MCP tools are classified apart. */
const FIXED: ReadonlyMap<string, ToolCategory> = new Map<string, ToolCategory>([
  ["update_plan", "plan"],
  ["view_image", "read"],
  ["web_search", "web"],
  // multi-agent tools: v2 (namespace `collaboration`) and v1 (`wait` with agent ids)
  ["spawn_agent", "delegate"], ["send_message", "delegate"], ["followup_task", "delegate"], ["wait_agent", "delegate"],
  ["interrupt_agent", "delegate"], ["list_agents", "delegate"], ["send_input", "delegate"], ["resume_agent", "delegate"],
  ["close_agent", "delegate"], ["wait", "delegate"],
  ["write_stdin", "shell"],
  ["sleep", "schedule"],
  ["list_mcp_resources", "mcp"], ["list_mcp_resource_templates", "mcp"], ["read_mcp_resource", "mcp"],
  // bookkeeping and talk with the person: questions and requests to the person, the clock, the context, waiting
  ["request_user_input", "meta"], ["request_user_input_async", "meta"], ["request_permissions", "meta"],
  ["request_plugin_install", "meta"], ["list_available_plugins_to_install", "meta"], ["tool_search", "meta"],
  ["current_time", "meta"], ["get_context_remaining", "meta"], ["new_context_window", "meta"], ["wait_for_environment", "meta"],
  ["send_message_to_user_async", "meta"],
  ["imagegen", "other"], ["image_generation", "other"], ["js_repl", "other"], ["js_repl_reset", "other"],
]);
/** Namespaces of the CLI's own tools; a tool in any other namespace is not a built-in, whatever its name. */
const OWN_NAMESPACES = new Set(["collaboration", "clock", "image_gen", "web"]);
/** Tools whose arguments carry a command line (`cmd`, or `command` as argv or string): the CLI's shell-command tools. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["exec_command", "shell", "shell_command", "container.exec", "local_shell"]);
/** Shells whose last argument after a `-c`-style flag is the script (`["/bin/zsh", "-lc", "<script>"]`). */
const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh", "pwsh", "powershell", "cmd"]);
const SCRIPT_FLAG = /^(?:-[A-Za-z]*c|\/c|-Command)$/i;
const MCP_NAME = /^mcp__(.+?)__(.+)$/;
const MCP_NAMESPACE = /^mcp__(.+?)(?:__)?$/;
/** Older CLIs named MCP tools `<server>__<tool>`. */
const SERVER_TOOL = /^([A-Za-z0-9_-]+?)__(.+)$/;
/** CommandExecution sources that are not a command the agent started: the person's `!` command, input to a running one. */
const NOT_AGENT_COMMANDS = new Set(["user_shell", "unified_exec_interaction"]);

const plain = (name: string, category: ToolCategory): CxToolCall => ({ name, category, checks: [] });
const mcp = (server: string | undefined): CxToolCall => (server === undefined ? plain("mcp", "mcp") : { ...plain("mcp", "mcp"), mcpServer: server });

/** The command line of `cmd`/`command`: a string as is; argv joined, or a shell's `-c` script unwrapped. */
function commandLine(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd) || !cmd.every((x) => typeof x === "string")) return "";
  const argv = cmd as string[];
  const shell = (argv[0] ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  if (argv.length >= 3 && SHELLS.has(shell) && SCRIPT_FLAG.test(argv[argv.length - 2]!)) return argv[argv.length - 1]!;
  return argv.join(" ");
}

/** A command's category and checks: `classifyCommand` of its command line, and whether it had one. */
function command(name: string, cmd: unknown): CxToolCall {
  const line = commandLine(cmd);
  const { category, checks } = classifyCommand(line);
  return { name, category, checks, commandLine: line.trim() !== "" };
}

function edit(ext: string | undefined, added: number, removed: number): CxToolCall {
  const c: CxToolCall = { ...plain("apply_patch", "edit"), added, removed };
  if (ext !== undefined) c.editExt = ext;
  return c;
}

/** Files and their added/removed line counts in apply_patch text (`*** Add|Update|Delete File: <path>` sections). */
export function patchFiles(patch: string): { ext?: string; added: number; removed: number }[] {
  const out: { ext?: string; added: number; removed: number }[] = [];
  let cur: { ext?: string; added: number; removed: number } | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      cur = { added: 0, removed: 0 };
      const ext = extOfPath(header[1]!.trim());
      if (ext !== undefined) cur.ext = ext;
      out.push(cur);
    } else if (cur && !line.startsWith("*** ")) {
      if (line.startsWith("+")) cur.added++;
      else if (line.startsWith("-")) cur.removed++;
    }
  }
  return out;
}

const patchCalls = (patch: string): CxToolCall[] => patchFiles(patch).map((f) => edit(f.ext, f.added, f.removed));

/** Lines of file text (a trailing newline ends the last line). */
function lineCount(text: unknown): number {
  if (typeof text !== "string" || text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Added/removed lines of a unified diff; `---`/`+++` file headers before the first hunk are not lines. */
function diffLines(diff: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  if (typeof diff !== "string") return { added, removed };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) continue;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** A FileChange item's `changes` (`{<path>: {type: add|update|delete, content | unified_diff}}`): one edit per file. */
function fileChanges(changes: unknown): CxToolCall[] {
  if (!isObj(changes)) return [];
  return Object.entries(changes).map(([file, ch]) => {
    const c = isObj(ch) ? ch : {};
    const ext = extOfPath(file);
    if (c.type === "update") {
      const { added, removed } = diffLines(c.unified_diff);
      return edit(ext, added, removed);
    }
    if (c.type === "add") return edit(ext, lineCount(c.content), 0);
    if (c.type === "delete") return edit(ext, 0, lineCount(c.content));
    return edit(ext, 0, 0);
  });
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

/** A function or custom tool call by name (`namespace` for namespaced tools). */
function callOf(name: string | undefined, args: unknown, namespace: string | undefined): CxToolCall[] {
  const nsServer = namespace === undefined ? undefined : MCP_NAMESPACE.exec(namespace)?.[1];
  if (nsServer !== undefined) return [mcp(nsServer)];
  if (name === undefined) return [plain("other", "other")];
  // Code Mode: `exec` runs JavaScript whose nested tool calls the CLI records as items; `wait` resumes such a cell
  if (name === "exec" || (name === "wait" && isObj(args) && "cell_id" in args)) return [];
  if (namespace !== undefined && !OWN_NAMESPACES.has(namespace)) return [plain("other", "other")];
  if (namespace === "web") return [plain("web_search", "web")]; // the CLI's web tool (searches and opens pages)
  if (name === "apply_patch") return patchCalls(isObj(args) && typeof args.input === "string" ? args.input : "");
  if (SHELL_TOOLS.has(name)) return [command(name, isObj(args) ? (args.cmd ?? args.command) : undefined)];
  const fixed = FIXED.get(name);
  if (fixed !== undefined) return [plain(name, fixed)];
  const server = MCP_NAME.exec(name)?.[1] ?? SERVER_TOOL.exec(name)?.[1];
  return [server === undefined ? plain("other", "other") : mcp(server)];
}

/**
 * The tool actions in one rollout entry: a response_item payload (`function_call`, `custom_tool_call`, `local_shell_call`,
 * `web_search_call`) or a completed item (`CommandExecution`, `FileChange`, `McpToolCall`, `ImageView`, `Extension`,
 * `CollabAgentToolCall`, `DynamicToolCall`). One entry per call, or per file for apply_patch; none for Code Mode cells,
 * commands the person ran, input sent to a running command, and entries that are not tool actions. Command, patch and
 * argument text never leave.
 */
export function cxToolCalls(item: unknown): CxToolCall[] {
  if (!isObj(item)) return [];
  switch (item.type) {
    case "function_call":
      return callOf(str(item.name), parseArgs(item.arguments), str(item.namespace));
    case "custom_tool_call":
      return item.name === "apply_patch" ? patchCalls(typeof item.input === "string" ? item.input : "") : callOf(str(item.name), undefined, undefined);
    case "local_shell_call":
      return [command("local_shell", isObj(item.action) ? item.action.command : undefined)];
    case "web_search_call":
      return [plain("web_search", "web")];
    case "CommandExecution":
      return typeof item.source === "string" && NOT_AGENT_COMMANDS.has(item.source) ? [] : [command("exec_command", item.command)];
    case "FileChange":
      return fileChanges(item.changes);
    case "McpToolCall":
      return [mcp(str(item.server))];
    case "ImageView":
      return [plain("view_image", "read")];
    case "Extension":
      return item.kind === "web.search" ? [plain("web_search", "web")] : [];
    case "CollabAgentToolCall": {
      const tool = str(item.tool);
      return [plain(tool !== undefined && FIXED.get(tool) === "delegate" ? tool : "other", "delegate")];
    }
    case "DynamicToolCall":
      return [plain("other", "other")];
    default:
      return [];
  }
}

function durationMs(d: unknown): number | undefined {
  if (!isObj(d)) return undefined;
  const s = num(d.secs);
  const ns = num(d.nanos) ?? 0;
  return s !== undefined && s >= 0 && ns >= 0 ? Math.round(s * 1000 + ns / 1e6) : undefined;
}

/**
 * Outcome of a completed item: `declined` (the person refused the approval: it never ran) → outcome `denied`, no ok or
 * exit; else exit code (ok = exit 0), else ok from `status`; duration from `{secs, nanos}`.
 */
export function cxOutcome(item: unknown): CxOutcome {
  if (!isObj(item)) return {};
  const out: CxOutcome = {};
  const exit = num(item.exit_code);
  if (item.status === "declined") out.outcome = "denied";
  else if (exit !== undefined) {
    out.exit = exit;
    out.ok = exit === 0;
  } else if (item.status === "completed") out.ok = true;
  else if (item.status === "failed") out.ok = false;
  const ms = durationMs(item.duration);
  if (ms !== undefined) out.ms = ms;
  return out;
}
