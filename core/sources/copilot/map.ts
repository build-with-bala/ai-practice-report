import type { Platform } from "../../env/env";
import { toEpochMs } from "../../io/time";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv, TurnEv } from "../../model/events";
import { sid, type CheckKind, type Origin, type ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { typeKey, type Tally } from "../common/coverage";
import { extOfPath, idPart, isObj, num, safeModel, str, UUID, VERSION, type Obj } from "../common/guards";
import type { ScanCtx } from "../types";

export const VSCODE_SOURCE = "copilot.vscode";
export const TOOL = "copilot";
export const TASK_GAP_MS = 30 * 60_000;

/** A Copilot session id, `copilot:<id>`: the tool's own id verbatim when UUID-shaped, else its keyed hash. */
export const cpSessionId = (raw: string, ctx: ScanCtx): string => sid(TOOL, idPart(raw, UUID, ctx));

const VENDOR = /^[a-z][a-z0-9-]{0,31}\/(.+)$/;
/** A model id as VS Code records it (`<vendor>/<id>`, e.g. `copilot/<id>`): the vendor prefix dropped, then the shared guard. */
export function cpModel(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : safeModel(VENDOR.exec(raw)?.[1] ?? raw);
}

/** The path of a `file:` or `vscode-remote:` URI (a Windows drive or UNC path on win32); undefined for other URIs. */
export function uriToPath(uri: string, platform: Platform): string | undefined {
  let u: URL;
  let p: string;
  try {
    u = new URL(uri);
    p = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "file:" && u.protocol !== "vscode-remote:") || p === "") return undefined;
  if (u.protocol === "file:" && platform === "win32") {
    p = u.host ? `//${u.host}${p}` : p.replace(/^\/([A-Za-z]:)/, "$1");
    p = p.replace(/\//g, "\\");
  }
  return p;
}

/** Response part kinds VS Code writes (its serializer and response model, 1.138, plus kinds older versions wrote); any other kind is drift. */
const PART_KINDS: ReadonlySet<string> = new Set([
  "markdownContent", "toolInvocationSerialized", "toolInvocation", "prepareToolInvocation", "elicitationSerialized", "elicitation",
  "progressTaskSerialized", "progressTask", "progressMessage", "textEditGroup", "notebookEditGroup", "multiDiffData", "workspaceEdit",
  "externalEdit", "codeblockUri", "inlineReference", "codeCitation", "markdownVuln", "thinking", "undoStop", "confirmation", "command",
  "extensions", "hook", "disabledClaudeHooks", "mcpServersStarting", "mcpServersStartingSlow", "mcpAuthenticationRequired", "voiceProgress",
  "planReview", "autoModeResolution", "clearToPreviousToolInvocation", "systemNotification", "pullRequest", "questionCarousel", "warning",
  "info", "treeData",
]);
const TOOL_PARTS = new Set(["toolInvocationSerialized", "toolInvocation"]);
const EDIT_GROUPS = new Set(["textEditGroup", "notebookEditGroup"]);

/** Built-in tools of VS Code (1.138) and the Copilot Chat extension (0.66 and older names); terminal tools are classified by their command. */
const VSCODE_TOOLS: ReadonlyMap<string, ToolCategory> = new Map<string, ToolCategory>([
  ...(["copilot_readFile", "copilot_viewImage", "copilot_listDirectory", "copilot_readProjectStructure", "copilot_getNotebookSummary",
    "copilot_readNotebookCellOutput", "copilot_getErrors", "copilot_testFailure"] as const).map((n) => [n, "read"] as const),
  ...(["copilot_searchCodebase", "copilot_findFiles", "copilot_findTextInFiles", "copilot_searchWorkspaceSymbols", "copilot_findTestFiles",
    "vscode_listCodeUsages", "copilot_listCodeUsages", "copilot_githubTextSearch"] as const).map((n) => [n, "search"] as const),
  ...(["copilot_applyPatch", "copilot_replaceString", "copilot_multiReplaceString", "copilot_insertEdit", "copilot_editNotebook", "copilot_editFiles",
    "copilot_editFile", "vscode_editFile_internal", "vscode_renameSymbol"] as const).map((n) => [n, "edit"] as const),
  ...(["copilot_createFile", "copilot_createNewJupyterNotebook"] as const).map((n) => [n, "write"] as const),
  ...(["run_in_terminal", "copilot_runInTerminal", "send_to_terminal", "get_terminal_output", "copilot_getTerminalOutput", "kill_terminal",
    "terminal_last_command", "copilot_getTerminalLastCommand", "terminal_selection", "copilot_getTerminalSelection", "run_task", "copilot_runTask",
    "create_and_run_task", "copilot_createAndRunTask", "get_task_output", "copilot_getTaskOutput"] as const).map((n) => [n, "shell"] as const),
  ...(["runTests", "copilot_runTests1"] as const).map((n) => [n, "test"] as const),
  ["copilot_runNotebookCell", "notebook"],
  ["copilot_getChangedFiles", "git"],
  ...(["copilot_fetchWebPage", "vscode_fetchWebPage_internal", "copilot_githubRepo"] as const).map((n) => [n, "web"] as const),
  ...(["runSubagent", "search_subagent", "explore_subagent", "execution_subagent"] as const).map((n) => [n, "delegate"] as const),
  ...(["manage_todo_list", "todos"] as const).map((n) => [n, "todo"] as const),
  ["vscode_reviewPlan", "plan"],
  ["skill", "skill"],
  ...(["click_element", "drag_element", "handle_dialog", "hover_element", "navigate_page", "read_page", "run_playwright_code", "screenshot_page",
    "type_in_page", "copilot_openSimpleBrowser"] as const).map((n) => [n, "browser"] as const),
  // bookkeeping and talk with the person: thinking aloud, questions and confirmations, switching agents
  ...(["copilot_think", "vscode_askQuestions", "copilot_askQuestions", "vscode_get_confirmation", "vscode_get_terminal_confirmation",
    "copilot_switchAgent"] as const).map((n) => [n, "meta"] as const),
  ...(["copilot_getVSCodeAPI", "copilot_runVscodeCommand", "copilot_createNewWorkspace", "copilot_createDirectory", "copilot_installExtension",
    "vscode_searchExtensions_internal", "copilot_memory", "copilot_resolveMemoryFileUri", "copilot_sessionStoreSql", "copilot_getProjectSetupInfo",
    "copilot_getDocInfo", "copilot_getSearchResults", "copilot_updateUserPreferences"] as const).map((n) => [n, "other"] as const),
]);
/** Tools that run a command line in a terminal (`toolSpecificData.kind: "terminal"`). */
const TERMINAL_TOOLS = new Set(["run_in_terminal", "copilot_runInTerminal", "send_to_terminal"]);
const TOOL_CHECKS: ReadonlyMap<string, CheckKind[]> = new Map([["runTests", ["test"]], ["copilot_runTests1", ["test"]]]);
/** The participant of agent mode (package.json: `modes: ["agent"]`); the bare id is accepted too. */
const AGENT_PARTICIPANTS = new Set(["github.copilot.editsAgent", "editsAgent"]);
/** `modelState.value` (VS Code's ResponseModelState): 0 pending, 1 complete, 2 cancelled, 3 failed, 4 waiting for input. */
const FINISHED: ReadonlyMap<unknown, NonNullable<TurnEv["status"]>> = new Map<unknown, NonNullable<TurnEv["status"]>>([[1, "completed"], [2, "interrupted"], [3, "failed"]]);
const NOT_ENDED = new Set<unknown>([0, 4]);

/** Agent mode: `modeInfo.kind` (current format), the agent-mode participant, or a participant whose only mode is `agent`. */
export function isAgentMode(r: Obj): boolean {
  if (isObj(r.modeInfo) && r.modeInfo.kind === "agent") return true;
  const a = isObj(r.agent) ? r.agent : undefined;
  if (!a) return false;
  if (typeof a.id === "string" && AGENT_PARTICIPANTS.has(a.id)) return true;
  return Array.isArray(a.modes) && a.modes.length === 1 && a.modes[0] === "agent";
}

/** The command a terminal tool ran: the person's edit, else VS Code's rewrite, else the model's original; legacy `command`. */
function terminalCommand(tsd: Obj): string | undefined {
  const cl = isObj(tsd.commandLine) ? tsd.commandLine : undefined;
  return (cl ? str(cl.userEdited) ?? str(cl.toolEdited) ?? str(cl.original) : undefined) ?? str(tsd.command);
}

/**
 * A tool that did not run, from its confirmation (`isConfirmed`): kind 0 (older files: `false`) is VS Code's Denied —
 * the person refused it, or, in a request that was cancelled, it was left waiting and dropped (`cancelled`); kind 5 is
 * Skipped (`cancelled`). Undefined for a tool that ran.
 */
function notRun(c: unknown, cancelled: boolean): ToolEv["outcome"] {
  const kind = isObj(c) ? c.type : c === false ? 0 : undefined;
  if (kind === 0) return cancelled ? "cancelled" : "denied";
  return kind === 5 ? "cancelled" : undefined;
}

/** A request whose response was cancelled: `modelState.value` 2 (current format), else `isCanceled`. */
const cancelledRequest = (r: Obj): boolean => (isObj(r.modelState) ? r.modelState.value === 2 : r.isCanceled === true);

/** The path of a serialized URI (`UriComponents`, or a URI string). */
function uriPath(u: unknown): string | undefined {
  if (isObj(u)) return str(u.path) ?? str(u.fsPath);
  if (typeof u !== "string") return undefined;
  try {
    return decodeURIComponent(new URL(u).pathname);
  } catch {
    return undefined;
  }
}

/** The first file a tool's message links to (`pastTenseMessage`/`invocationMessage` `.uris` values; their keys are never read). */
function messagePath(p: Obj): string | undefined {
  for (const m of [p.pastTenseMessage, p.invocationMessage]) {
    if (!isObj(m) || !isObj(m.uris)) continue;
    for (const u of Object.values(m.uris)) {
      const found = uriPath(u);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The raw id of a session object: its `sessionId`, else the file name it was read from. */
export const rawSessionId = (root: Obj, stem: string): string => str(root.sessionId) ?? stem;

/** Where a session's project is: the folder of its workspace (from `workspace.json`), when the session does not name its own. */
export interface SessionSpec { stem: string; cwd?: string }

interface PendingEdit { ev: ToolEv; path?: string }

/** Maps one chat session object (a legacy file's root or a replayed journal) to events; the object is not kept. */
class SessionMapper {
  private readonly id: string;
  private start?: number;
  private end?: number;
  private readonly models: string[] = [];
  private agent = false;
  private version?: string;
  private humanPrompts = 0;
  private prevHuman?: string;
  private lastActivity?: number;

  constructor(private readonly root: Obj, private readonly spec: SessionSpec, private readonly ctx: ScanCtx, private readonly tally: Tally) {
    this.id = cpSessionId(rawSessionId(root, spec.stem), ctx);
  }

  private span(t: number | undefined): void {
    if (t === undefined) return;
    if (this.start === undefined || t < this.start) this.start = t;
    if (this.end === undefined || t > this.end) this.end = t;
  }

  private out(ev: Ev & { ts: number }): void {
    this.span(ev.ts);
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  run(requests: unknown[]): void {
    this.span(toEpochMs(this.root.creationDate, this.ctx.now));
    this.span(toEpochMs(this.root.lastMessageDate, this.ctx.now));
    for (const r of requests) {
      if (isObj(r)) this.request(r);
      else this.tally.unknownKey("request:not-object");
    }
    this.session();
  }

  private request(r: Obj): void {
    const ts = toEpochMs(r.timestamp, this.ctx.now);
    const model = cpModel(str(r.modelId));
    if (model !== undefined && !this.models.includes(model)) this.models.push(model);
    if (isAgentMode(r)) this.agent = true;
    const version = isObj(r.agent) ? str(r.agent.extensionVersion) : undefined;
    if (version !== undefined && VERSION.test(version)) {
      this.version = version;
      this.tally.versions.add(version);
    }
    if (ts !== undefined) {
      this.span(ts);
      this.prompt(r, ts);
      this.tools(r, ts, cancelledRequest(r));
    }
    const ended = this.turn(r, ts, model);
    const last = ended ?? ts;
    if (last !== undefined) this.lastActivity = last;
  }

  /** The person's message: text in memory only, for intent, features and a keyed hash. System-initiated requests are not human. */
  private prompt(r: Obj, ts: number): void {
    const text = typeof r.message === "string" ? r.message : isObj(r.message) && typeof r.message.text === "string" ? r.message.text : undefined;
    if (text === undefined || text.trim() === "") return;
    const origin: Origin = r.isSystemInitiated === true ? "system" : "human";
    const human = origin === "human";
    const isTaskStart = human && (this.humanPrompts === 0 || (this.lastActivity !== undefined && ts - this.lastActivity >= TASK_GAP_MS));
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: VSCODE_SOURCE, ts, sessionId: this.id, window: "detail", origin,
      intent: classifyIntent(text), features: promptFeatures(text, { isTaskStart, prevText: human ? this.prevHuman : undefined }),
      textHash: this.ctx.hash(text.trim()),
    };
    this.out(ev);
    if (human) {
      this.humanPrompts++;
      this.prevHuman = text;
    }
  }

  /**
   * One ToolEv per tool invocation, at the request's time. An edit tool claims the edit group that follows it (same file
   * when the tool names one, else the oldest edit tool still waiting) and takes its file extension; a group no edit tool
   * claims is an edit of its own, unless an edit tool ran earlier in the response (the extra files of a multi-file edit).
   */
  private tools(r: Obj, ts: number, cancelled: boolean): void {
    const parts = Array.isArray(r.response) ? r.response : [];
    const evs: ToolEv[] = [];
    const pending: PendingEdit[] = [];
    let sawEditTool = false;
    for (const p of parts) {
      if (!isObj(p) || p.kind === undefined) continue; // markdown is stored as the bare markdown string object
      const kind = p.kind;
      if (typeof kind !== "string" || !PART_KINDS.has(kind)) {
        this.tally.unknownKey(`part:${typeKey(kind)}`);
        continue;
      }
      if (TOOL_PARTS.has(kind)) {
        const { ev, path } = this.toolEv(p, ts, cancelled);
        evs.push(ev);
        if (ev.category === "edit" || ev.category === "write") {
          sawEditTool = true;
          pending.push(path === undefined ? { ev } : { ev, path });
        }
      } else if (EDIT_GROUPS.has(kind)) {
        const path = uriPath(p.uri);
        const ext = path === undefined ? undefined : extOfPath(path);
        let at = path === undefined ? -1 : pending.findIndex((e) => e.path === path);
        if (at < 0) at = pending.findIndex((e) => e.path === undefined);
        if (at >= 0) {
          const [claim] = pending.splice(at, 1);
          if (claim!.ev.editExt === undefined && ext !== undefined) claim!.ev.editExt = ext;
        } else if (!sawEditTool) {
          const ev: ToolEv = { k: "tool", tool: TOOL, source: VSCODE_SOURCE, ts, sessionId: this.id, name: kind, category: "edit" };
          if (ext !== undefined) ev.editExt = ext;
          evs.push(ev);
        }
      }
    }
    for (const ev of evs) {
      this.out(ev);
      if (ev.outcome === "denied") this.out({ k: "marker", tool: TOOL, source: VSCODE_SOURCE, ts, sessionId: this.id, kind: "denial", detail: "user" });
    }
  }

  private toolEv(p: Obj, ts: number, cancelled: boolean): { ev: ToolEv; path?: string } {
    const id = str(p.toolId) ?? str(p.toolName);
    const ev: ToolEv = { k: "tool", tool: TOOL, source: VSCODE_SOURCE, ts, sessionId: this.id, name: "other", category: "other" };
    const callId = str(p.toolCallId);
    if (callId !== undefined) ev.callId = this.ctx.hash(callId);
    const src = isObj(p.source) ? p.source : undefined;
    if (src?.type === "mcp" || (id !== undefined && !VSCODE_TOOLS.has(id) && id.startsWith("mcp_"))) {
      ev.name = "mcp";
      ev.category = "mcp";
      const server = src?.type === "mcp" ? str(src.serverLabel) ?? str(src.label) : undefined;
      if (server !== undefined) ev.mcpServer = server;
    } else if (id !== undefined && VSCODE_TOOLS.has(id)) {
      ev.name = id;
      ev.category = VSCODE_TOOLS.get(id)!;
      const checks = TOOL_CHECKS.get(id);
      if (checks) ev.checks = [...checks];
    }
    const tsd = isObj(p.toolSpecificData) ? p.toolSpecificData : undefined;
    if (id !== undefined && TERMINAL_TOOLS.has(id) && tsd?.kind === "terminal") {
      const cmd = terminalCommand(tsd);
      if (cmd !== undefined) {
        const { category, checks } = classifyCommand(cmd);
        ev.category = category;
        if (checks.length > 0) ev.checks = checks;
      }
      const state = isObj(tsd.terminalCommandState) ? tsd.terminalCommandState : undefined;
      const exit = num(state?.exitCode);
      if (exit !== undefined) ev.exit = exit;
      const ms = num(state?.duration);
      if (ms !== undefined && ms >= 0) ev.ms = ms;
    }
    const outcome = notRun(p.isConfirmed, cancelled);
    if (outcome !== undefined) {
      ev.outcome = outcome;
      delete ev.exit; // a tool that did not run has no exit code of its own
    } else if (ev.exit !== undefined) ev.ok = ev.exit === 0;
    else if (isObj(p.resultDetails) && typeof p.resultDetails.isError === "boolean") ev.ok = !p.resultDetails.isError;
    if (ev.category !== "edit" && ev.category !== "write") return { ev };
    const path = messagePath(p);
    if (path === undefined) return { ev };
    const ext = extOfPath(path);
    if (ext !== undefined) ev.editExt = ext;
    return { ev, path };
  }

  /**
   * A TurnEv for a request whose response ended: status from `modelState` (current format), else `isCanceled` / the
   * result's error; `ms` = `elapsedMs`, else the result's `timings.totalElapsed`, else completion − response start
   * (`timeSpentWaiting` is not a duration of the turn). A cancelled request is also an interrupt marker. Returns the end time.
   */
  private turn(r: Obj, ts: number | undefined, model: string | undefined): number | undefined {
    const state = isObj(r.modelState) ? r.modelState : undefined;
    let status: TurnEv["status"];
    if (state) {
      status = FINISHED.get(state.value);
      if (status === undefined) {
        if (!NOT_ENDED.has(state.value)) this.tally.unknownKey(`modelState:${typeof state.value === "number" && Number.isInteger(state.value) && state.value >= 0 && state.value < 100 ? state.value : "(other)"}`);
        return undefined;
      }
    } else if (r.isCanceled === true) status = "interrupted";
    else if (Array.isArray(r.response) || isObj(r.result)) status = isObj(r.result) && r.result.errorDetails !== undefined ? "failed" : "completed";
    else return undefined;
    const completedAt = state ? toEpochMs(state.completedAt, this.ctx.now) : undefined;
    const started = toEpochMs(r.responseTimestamp, this.ctx.now) ?? ts;
    const elapsed = num(r.elapsedMs);
    const total = isObj(r.result) && isObj(r.result.timings) ? num(r.result.timings.totalElapsed) : undefined;
    let ms = elapsed !== undefined && elapsed >= 0 ? elapsed : total !== undefined && total >= 0 ? total : undefined;
    if (ms === undefined && completedAt !== undefined && started !== undefined && completedAt >= started) ms = completedAt - started;
    const at = completedAt ?? (ts !== undefined && ms !== undefined ? ts + ms : ts);
    if (at === undefined) return undefined;
    if (status === "interrupted") {
      const m: MarkerEv = { k: "marker", tool: TOOL, source: VSCODE_SOURCE, ts: completedAt ?? ts ?? at, sessionId: this.id, kind: "interrupt", detail: "user" };
      this.out(m);
    }
    const ev: TurnEv = { k: "turn", tool: TOOL, source: VSCODE_SOURCE, ts: at, sessionId: this.id, window: "detail", status };
    if (model !== undefined) ev.model = model;
    if (ms !== undefined) ev.ms = ms;
    this.out(ev);
    return at;
  }

  private session(): void {
    if (this.start === undefined || this.end === undefined) return;
    const s: SessionEv = {
      k: "session", tool: TOOL, source: VSCODE_SOURCE, id: this.id, window: "detail", origin: "human", start: this.start, end: this.end,
      models: [...this.models], surface: "vscode", mode: this.agent ? "agent" : "chat",
    };
    if (this.version !== undefined) s.version = this.version;
    const own = str(this.root.workingDirectory);
    const cwd = (own === undefined ? undefined : uriToPath(own, this.ctx.env.platform)) ?? this.spec.cwd;
    if (cwd !== undefined) s.projectKey = this.ctx.registerCwd(cwd);
    this.ctx.emit(s);
    this.tally.span(this.start);
    this.tally.span(this.end);
  }
}

/**
 * Maps one chat session object — a legacy `.json` file's root or a replayed journal — to its session, prompts, tools,
 * turns and interrupts. A session without requests (VS Code creates one whenever the chat view opens) emits nothing and
 * is counted as skipped `empty-session`. A session `version` above 3 is drift `version:newer`.
 */
export function mapSession(root: unknown, spec: SessionSpec, ctx: ScanCtx, tally: Tally): void {
  if (!isObj(root)) return tally.unknownKey("session:not-object");
  const version = num(root.version);
  if (version !== undefined && version > 3) tally.unknownKey("version:newer");
  if (!Array.isArray(root.requests)) return tally.unknownKey("requests:missing");
  if (root.requests.length === 0) return tally.skip("empty-session");
  new SessionMapper(root, spec, ctx, tally).run(root.requests);
}
