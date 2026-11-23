// Synthetic GitHub Copilot stores. Field names mirror VS Code's own chat session schema (version 3, VS Code 1.138), the
// Copilot CLI's session events and its session store; every value is invented.
import path from "node:path";
import { vscodeUser } from "../../core/env/paths";
import { CANARY } from "../kit/canary";
import type { FakeHome } from "../kit/home";
import { fixtureStart } from "./claude-code";

export const CP_GPT = "copilot/gpt-5.1";
export const CP_SONNET = "copilot/claude-sonnet-5";
export const CP_EXT_VERSION = "0.40.1";
export const MIN = 60_000;

/** A UUID-shaped session id (VS Code names sessions by UUID) derived from a short label of ≤ 6 ASCII characters. */
export function cpSid(label: string): string {
  return `00000000-0000-4000-9000-${Buffer.from(label, "latin1").toString("hex").padStart(12, "0").slice(-12)}`;
}

export const S_J = cpSid("S-J");
export const S_L = cpSid("S-L");

/** Home-relative folder of a VS Code app's user data (`vscodeUser`), whatever the platform. */
export const userRel = (h: FakeHome, app = "Code"): string => path.relative(h.env.home, vscodeUser(h.env, app));

/** A `file:` URL for a POSIX-style path, the same on every host (`pathToFileURL` would add the host's drive on Windows). */
export const fileUrl = (p: string): string => `file://${encodeURI(p.startsWith("/") ? p : `/${p}`)}`;

/** VS Code's serialized URI (`UriComponents` plus the cached `fsPath`/`external` it writes). */
export function fileUri(p: string): Record<string, unknown> {
  return { $mid: 1, fsPath: p, external: fileUrl(p), path: p, scheme: "file" };
}

/** A bare markdown part: VS Code stores markdown content as the IMarkdownString itself, without a `kind`. */
export const markdown = (value: string): Record<string, unknown> => ({ value, supportThemeIcons: false, supportHtml: false, uris: {} });

export interface ToolOpts { callId?: string; confirmed?: unknown; resultDetails?: unknown; source?: unknown; messageUri?: string; specific?: unknown }

/** A `toolInvocationSerialized` part as VS Code writes it once the tool finished. */
export function tool(toolId: string, o: ToolOpts = {}): Record<string, unknown> {
  const uris = o.messageUri === undefined ? {} : { [fileUrl(o.messageUri)]: { $mid: 1, path: o.messageUri, scheme: "file" } };
  return {
    kind: "toolInvocationSerialized", presentation: undefined,
    invocationMessage: { value: `Using ${toolId} on ${CANARY.path}`, supportThemeIcons: false, supportHtml: false, uris },
    pastTenseMessage: { value: `Used ${toolId} ${CANARY.code}`, supportThemeIcons: false, supportHtml: false, uris },
    isConfirmed: o.confirmed ?? { type: 1 }, isComplete: true,
    source: o.source ?? { type: "internal", label: "Built-In" },
    resultDetails: o.resultDetails,
    toolSpecificData: o.specific,
    toolCallId: o.callId ?? `call_${toolId}_${CANARY.secret}`, toolId,
  };
}

/** The terminal tool running `cmd` (current shape: `commandLine.original`, with `toolEdited`/`userEdited` when given). */
export function terminal(cmd: string, exitCode?: number, duration?: number, edits: { toolEdited?: string; userEdited?: string } = {}): Record<string, unknown> {
  return tool("run_in_terminal", {
    specific: {
      kind: "terminal", commandLine: { original: cmd, ...edits }, language: "sh", terminalToolSessionId: `term-${CANARY.secret}`,
      terminalCommandOutput: { text: `${CANARY.secret}\n${CANARY.code}` },
      ...(exitCode !== undefined && { terminalCommandState: { exitCode, ...(duration !== undefined && { duration }) } }),
    },
  });
}

/** A `textEditGroup` part on `file` (edits of one file, merged while the tool streams them). */
export function editGroup(file: string, kind = "textEditGroup"): Record<string, unknown> {
  return { kind, uri: fileUri(file), edits: [[{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: CANARY.code }]], done: true };
}

export interface ReqOpts {
  id?: string; text?: string; ts: number; modelId?: string; agentId?: string; modes?: string[]; parts?: unknown[]; canceled?: boolean;
  modelState?: unknown; elapsedMs?: number; totalElapsed?: number; timeSpentWaiting?: number; extra?: Record<string, unknown>; extVersion?: string;
}

let reqSeq = 0;
/** One serialized request (`ISerializableChatRequestData`), with canaries in every field the reader must never keep. */
export function request(o: ReqOpts): Record<string, unknown> {
  const text = o.text ?? "Explain the importer";
  const agentId = o.agentId ?? "github.copilot.default";
  return {
    requestId: o.id ?? `request_${++reqSeq}`,
    message: { text, parts: [{ kind: "text", text, range: { start: 0, endExclusive: text.length }, editorRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 } }] },
    variableData: { variables: [{ id: "file", name: CANARY.project, value: fileUri(`${CANARY.path}/notes.md`), kind: "file" }] },
    response: o.parts ?? [markdown(`Sure. ${CANARY.code}`)],
    responseId: `response_${reqSeq}`,
    result: {
      ...(o.totalElapsed !== undefined && { timings: { firstProgress: 800, totalElapsed: o.totalElapsed } }),
      metadata: { renderedUserMessage: [{ type: 1, text: CANARY.prompt }], toolCallRounds: [{ id: "round", response: CANARY.code, toolCalls: [] }], sessionId: CANARY.secret },
    },
    followups: [],
    ...(o.canceled !== undefined && { isCanceled: o.canceled }),
    ...(o.modelState !== undefined && { modelState: o.modelState }),
    ...(o.elapsedMs !== undefined && { elapsedMs: o.elapsedMs }),
    ...(o.timeSpentWaiting !== undefined && { timeSpentWaiting: o.timeSpentWaiting }),
    agent: {
      extensionId: { value: "GitHub.copilot-chat", _lower: "github.copilot-chat" }, extensionVersion: o.extVersion ?? CP_EXT_VERSION, publisherDisplayName: "GitHub",
      extensionPublisherId: "GitHub", extensionDisplayName: "GitHub Copilot Chat", id: agentId, description: CANARY.prompt, when: "true",
      metadata: { themeIcon: { id: "copilot" }, hasFollowups: false }, name: agentId.split(".").pop(), fullName: "GitHub Copilot", isDefault: true,
      locations: ["panel"], modes: o.modes ?? (agentId.endsWith("editsAgent") ? ["agent"] : ["ask"]), slashCommands: [], disambiguation: [],
    },
    contentReferences: [{ kind: "reference", reference: fileUri(`${CANARY.path}/secret.ts`) }],
    codeCitations: [],
    timestamp: o.ts,
    ...(o.modelId !== undefined && { modelId: o.modelId }),
    editedFileEvents: [{ eventKind: 1, uri: fileUri(`${CANARY.path}/app/main.py`) }],
    ...o.extra,
  };
}

/** A version-3 session root, as legacy `.json` files hold it and journal snapshots (`kind:0`) carry it. */
export function sessionRoot(sessionId: string, requests: unknown[], o: { created?: number; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    version: 3, requesterUsername: CANARY.email, requesterAvatarIconUri: { $mid: 1, scheme: "https", authority: CANARY.host, path: "/u/1", query: "v=4" },
    responderUsername: "GitHub Copilot", responderAvatarIconUri: { id: "copilot" }, initialLocation: "panel",
    requests, sessionId, creationDate: o.created ?? fixtureStart(), isImported: false, lastMessageDate: o.created ?? fixtureStart(),
    customTitle: `${CANARY.project} refactor`,
    inputState: { inputText: CANARY.prompt, attachments: [], mode: { id: "agent", kind: "agent" }, selectedModel: { identifier: CP_GPT, metadata: { auth: { accountLabel: CANARY.email } } } },
    repoData: { remoteUrl: `https://${CANARY.host}/${CANARY.project}.git`, branch: "main" },
    ...o.extra,
  };
}

/** Journal records (`chatSessions/<id>.jsonl`): `kind:0` initial root, `kind:1` set at path `k`, `kind:2` push to the array at `k`, `kind:3` delete. */
export type JournalRecord = { kind: number; v?: unknown; k?: (string | number)[]; i?: number };

export interface CopilotFixture { t0: number; journalFile: string; legacyFile: string; copyFile: string; jetbrainsFile: string; appsFile: string; hostsFile: string }

/** Home-relative root of the JetBrains plugin's config (`<xdgConfig>/github-copilot`, `%LOCALAPPDATA%\github-copilot` on Windows). */
export function jetbrainsRel(h: FakeHome): string {
  const base = h.env.platform === "win32" ? h.env.localAppData! : h.env.xdgConfig;
  return path.relative(h.env.home, path.join(base, "github-copilot"));
}

/**
 * The Task 13 scenario. W1: a `.jsonl` journal of S-J (a snapshot with 1 request, a push of 2 requests — an agent-mode
 * one running `npm test` and editing `app/main.py`, and a cancelled one — then a set of request 0's model); W2: legacy
 * `.json` S-L with 2 requests; W3: a legacy `.json` copy of S-J. The JetBrains plugin's OAuth files hold a canary token,
 * and one JetBrains chat store exists.
 */
export function buildCopilot(h: FakeHome): CopilotFixture {
  const t0 = fixtureStart();
  const user = userRel(h);
  const ws = (id: string, folder: string) => {
    h.writeJson(path.join(user, "workspaceStorage", id, "workspace.json"), { folder: fileUrl(folder) });
    return path.join(user, "workspaceStorage", id, "chatSessions");
  };
  const w1 = ws("w1hash", CANARY.path);
  const w2 = ws("w2hash", "/work/projB");
  const w3 = ws("w3hash", "/work/projC");

  const req0 = request({ id: "request_j0", text: `Refactor the importer so it rejects empty input. ${CANARY.prompt}`, ts: t0 + MIN, totalElapsed: 9_000 });
  const req1 = request({
    id: "request_j1", text: "Run the tests and fix the failing one in app/main.py", ts: t0 + 5 * MIN, modelId: CP_SONNET, agentId: "github.copilot.editsAgent",
    parts: [markdown("Running the tests."), { kind: "prepareToolInvocation", toolName: "run_in_terminal" }, terminal(`npm test -- ${CANARY.path}`, 0, 4_200), editGroup(`${CANARY.path}/app/main.py`), markdown(CANARY.code)],
    modelState: { value: 1, completedAt: t0 + 5 * MIN + 41_000 }, elapsedMs: 41_000, totalElapsed: 42_000, timeSpentWaiting: t0 + 5 * MIN,
  });
  const req2 = request({ id: "request_j2", text: "Why is the parser slow?", ts: t0 + 9 * MIN, modelId: CP_GPT, canceled: true });
  const journal: JournalRecord[] = [
    { kind: 0, v: sessionRoot(S_J, [req0], { created: t0 }) },
    { kind: 2, k: ["requests"], v: [req1, req2] },
    { kind: 1, k: ["requests", 0, "modelId"], v: CP_GPT },
  ];
  const journalFile = h.writeJsonl(path.join(w1, `${S_J}.jsonl`), journal);

  const legacy = sessionRoot(S_L, [
    request({ id: "request_l0", text: "What does the scheduler do?", ts: t0 + 20 * MIN, modelId: CP_GPT, canceled: false, totalElapsed: 3_000, timeSpentWaiting: 0 }),
    request({ id: "request_l1", text: "Add a retry with exponential backoff to the fetch helper", ts: t0 + 25 * MIN, modelId: CP_GPT, canceled: false, totalElapsed: 7_000 }),
  ], { created: t0 + 19 * MIN });
  const legacyFile = h.writeJson(path.join(w2, `${S_L}.json`), legacy);

  // the same session in the legacy form: VS Code's older copy, never counted twice
  const copyFile = h.writeJson(path.join(w3, `${S_J}.json`), sessionRoot(S_J, [req0, req1, req2], { created: t0 }));

  const jb = jetbrainsRel(h);
  const appsFile = h.writeJson(path.join(jb, "apps.json"), { "github.com:Iv1.0000": { user: CANARY.email, oauth_token: CANARY.token, githubAppId: "Iv1.0000" } });
  const hostsFile = h.writeJson(path.join(jb, "hosts.json"), { "github.com": { user: CANARY.email, oauth_token: CANARY.token } });
  const jetbrainsFile = h.write(path.join(jb, "intellij", "chat-agent-sessions", "copilot-agent-sessions-nitrite.db"), `H2 nitrite ${CANARY.prompt} ${CANARY.token}`);
  return { t0, journalFile, legacyFile, copyFile, jetbrainsFile, appsFile, hostsFile };
}

// ---- Copilot CLI (from the CLI's session event schema and the store schema; not confirmed with the structure probe) ----

/** Builds one CLI `events.jsonl` record by record: `{type, data, id, timestamp, parentId}` with a running clock. */
export class CliEvents {
  readonly records: Record<string, unknown>[] = [];
  t: number;
  private seq = 0;
  private last: string | null = null;

  constructor(start: number = fixtureStart()) {
    this.t = start;
  }

  ev(type: string, data: Record<string, unknown> = {}, dt = 1_000): this {
    this.t += dt;
    const id = `evt-${++this.seq}`;
    this.records.push({ type, data, id, timestamp: new Date(this.t).toISOString(), parentId: this.last });
    this.last = id;
    return this;
  }
}

/** The session store's tables (the extension's copy and the CLI's share the schema), as the structure probe showed them. */
export const STORE_DDL = [
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, agent_name TEXT, agent_description TEXT, created_at TEXT, updated_at TEXT)",
  "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT)",
];

/** A session store with one session (`host`) and one turn; every text column the reader never selects holds a canary. */
export function writeSessionStore(h: FakeHome, rel: string, o: { id: string; host: string; at: number }): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  return h.sqlite(rel, STORE_DDL, {
    sessions: [[o.id, CANARY.path, CANARY.project, o.host, "main", CANARY.prompt, CANARY.project, CANARY.prompt, iso(o.at), iso(o.at + 9 * 60_000)]],
    turns: [[1, o.id, 0, CANARY.prompt, CANARY.code, iso(o.at + 60_000)]],
  });
}
