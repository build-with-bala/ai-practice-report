// Synthetic Cursor stores. Cursor is not installed on the fixture author's machine: table, key and field names follow the
// public descriptions FORMAT.md summarises (from docs, unverified locally); every value is invented.
import { Database } from "bun:sqlite";
import path from "node:path";
import { vscodeUser } from "../../core/env/paths";
import { CANARY } from "../kit/canary";
import type { FakeHome } from "../kit/home";
import { fixtureStart, MIN } from "./claude-code";

type Obj = Record<string, unknown>;

/** The key-value tables of a VS Code-family `state.vscdb` (as VS Code creates `ItemTable`, and Cursor `cursorDiskKV`). */
export const ITEM_DDL = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)";
export const KV_DDL = "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)";

/** A UUID-shaped composer or bubble id (Cursor names both by UUID) derived from a short label of ≤ 6 ASCII characters. */
export function cuSid(label: string): string {
  return `00000000-0000-4000-a000-${Buffer.from(label, "latin1").toString("hex").padStart(12, "0").slice(-12)}`;
}

/** Home-relative folder of Cursor's user data (`vscodeUser(env, "Cursor")`), whatever the platform. */
export const userRel = (h: FakeHome): string => path.relative(h.env.home, vscodeUser(h.env, "Cursor"));
export const globalRel = (h: FakeHome): string => path.join(userRel(h), "globalStorage", "state.vscdb");
export const workspaceRel = (h: FakeHome, ws: string): string => path.join(userRel(h), "workspaceStorage", ws, "state.vscdb");
export const trackingRel = path.join(".cursor", "ai-tracking", "ai-code-tracking.db");

export interface ComposerOpts {
  created?: unknown; updated?: unknown; agentic?: boolean; mode?: string; model?: string; headers?: string[];
  sub?: Obj; subIds?: string[]; subagentIds?: string[]; inline?: Obj[]; extra?: Obj;
}

/** A `composerData:<id>` value (format `_v` 3+), with canaries in every field the reader must never keep. */
export function composer(id: string, o: ComposerOpts = {}): Obj {
  return {
    _v: 10, composerId: id, name: `${CANARY.project} refactor`, richText: CANARY.code, hasLoaded: true, text: CANARY.prompt,
    fullConversationHeadersOnly: (o.headers ?? []).map((bubbleId, i) => ({ bubbleId, type: i % 2 === 0 ? 1 : 2 })),
    ...(o.created !== undefined && { createdAt: o.created }), ...(o.updated !== undefined && { lastUpdatedAt: o.updated }),
    status: "completed", ...(o.agentic !== undefined && { isAgentic: o.agentic }), ...(o.mode !== undefined && { unifiedMode: o.mode }),
    forceMode: "edit", ...(o.model !== undefined && { modelConfig: { modelName: o.model, maxMode: false } }),
    context: { selections: [{ uri: { fsPath: `${CANARY.path}/app.py` }, text: CANARY.code }] },
    gitWorktree: { worktreePath: CANARY.path, branchName: CANARY.project }, subtitle: CANARY.prompt,
    ...(o.sub !== undefined && { subagentInfo: o.sub }), ...(o.subIds !== undefined && { subComposerIds: o.subIds }),
    ...(o.subagentIds !== undefined && { subagentComposerIds: o.subagentIds }), ...(o.inline !== undefined && { conversation: o.inline }),
    ...o.extra,
  };
}

/** `toolFormerData` of a tool bubble; `params`, `rawArgs` and `result` are double-encoded JSON strings, as Cursor writes them. */
export interface ToolOpts { name?: string; tool?: number; params?: unknown; rawArgs?: unknown; result?: unknown; status?: string; decision?: string; callId?: string; raw?: boolean }

export function toolData(o: ToolOpts): Obj {
  const enc = (v: unknown) => (v === undefined || o.raw ? v : JSON.stringify(v));
  return {
    ...(o.tool !== undefined && { tool: o.tool }), toolIndex: 0, modelCallId: `mc-${CANARY.secret}`, toolCallId: o.callId ?? `call_${CANARY.secret}`,
    ...(o.status !== undefined && { status: o.status }), ...(o.name !== undefined && { name: o.name }),
    ...(o.params !== undefined && { params: enc(o.params) }), ...(o.rawArgs !== undefined && { rawArgs: enc(o.rawArgs) }),
    ...(o.result !== undefined && { result: enc(o.result) }), ...(o.decision !== undefined && { userDecision: o.decision }),
    additionalData: { note: CANARY.prompt },
  };
}

export interface BubbleOpts { type: number; ts?: unknown; text?: string; tool?: ToolOpts; thinkingMs?: number; error?: unknown; model?: string; extra?: Obj }

/** A `bubbleId:<composerId>:<bubbleId>` value: one message (type 1 user, type 2 assistant), canaries everywhere else. */
export function bubble(id: string, o: BubbleOpts): Obj {
  return {
    _v: 3, type: o.type, bubbleId: id, ...(o.ts !== undefined && { createdAt: typeof o.ts === "number" ? new Date(o.ts).toISOString() : o.ts }),
    text: o.text ?? (o.type === 2 ? `Here is the change. ${CANARY.code}` : ""), richText: JSON.stringify({ root: { text: CANARY.prompt } }),
    requestId: `req-${CANARY.secret}`, isAgentic: true, tokenCount: { inputTokens: 0, outputTokens: 0 },
    relevantFiles: [`${CANARY.path}/app.py`], recentlyViewedFiles: [`${CANARY.path}/db.py`], codeBlocks: [{ content: CANARY.code, uri: { path: CANARY.path } }],
    context: { selections: [{ uri: { fsPath: CANARY.path }, text: CANARY.code }] }, pullRequests: [], commits: [], gitDiffs: [],
    ...(o.model !== undefined && { modelInfo: { modelName: o.model } }),
    ...(o.tool !== undefined && { toolFormerData: toolData(o.tool), capabilityType: 15 }),
    ...(o.thinkingMs !== undefined && { thinkingDurationMs: o.thinkingMs, allThinkingBlocks: [{ text: CANARY.prompt }] }),
    ...(o.error !== undefined && { errorDetails: o.error }),
    ...o.extra,
  };
}

export type Row = [string, unknown];
const encode = (v: unknown): unknown => (typeof v === "string" || v instanceof Uint8Array || v === null ? v : JSON.stringify(v));

/**
 * A `state.vscdb` with `ItemTable` rows and, unless `kv` is false, `cursorDiskKV` rows — written in one transaction,
 * so stores of thousands of rows are quick to build on every platform (one sync, not one per row).
 */
export function writeStateDb(h: FakeHome, rel: string, kvRows: Row[], items: Row[] = [], o: { kv?: boolean; kvDdl?: string; wal?: boolean } = {}): string {
  const file = h.sqlite(rel, [ITEM_DDL, ...(o.kv === false ? [] : [o.kvDdl ?? KV_DDL])], {}, o.wal);
  const db = new Database(file);
  try {
    db.transaction(() => {
      const insert = (table: string, rows: Row[]) => {
        const st = db.query(`INSERT INTO ${table} VALUES (?, ?)`);
        for (const [k, v] of rows) st.run(k, encode(v) as never);
      };
      insert("ItemTable", items);
      if (o.kv !== false) insert("cursorDiskKV", kvRows);
    })();
  } finally {
    db.close();
  }
  return file;
}

/** Rows of `ItemTable` that hold the account's credentials: never queried. */
export const AUTH_ITEMS: Row[] = [
  ["cursorAuth/accessToken", CANARY.token], ["cursorAuth/refreshToken", CANARY.token], ["cursorAuth/cachedEmail", CANARY.email],
];

/** Key families of `cursorDiskKV` the reader never selects. */
export const OTHER_KV: Row[] = [
  ["agentKv:blob:00ff", new TextEncoder().encode(`\u0008\u0001${CANARY.code}${CANARY.token}`)],
  ["checkpointId:x:y", { files: [{ path: CANARY.path, content: CANARY.code }] }],
  ["messageRequestContext:x:y", { gitStatusRaw: CANARY.secret, terminalFiles: [CANARY.path] }],
  ["codeBlockDiff:x:y", { diff: CANARY.code }],
];

export const A = cuSid("A");
export const B = cuSid("B");
export const CU_SONNET = "claude-sonnet-5";
export const CU_GPT = "gpt-5.1";

export interface CursorFixture { t0: number; globalFile: string; trackingFile: string; texts: string[] }

/**
 * The Task 14 scenario. `state.vscdb`: composer A (agentic) with two user bubbles and three tool bubbles that run
 * `pytest -q` (accepted, accepted with `errorDetails`, rejected; the first with `thinkingDurationMs: 900`), composer B
 * (chat) with one user bubble; other key families and `ItemTable` credential rows hold canaries.
 * `ai-code-tracking.db`: two `scored_commits` rows, every name-like column a canary.
 */
export function buildCursor(h: FakeHome): CursorFixture {
  const t0 = fixtureStart();
  const texts = [`Make the importer reject empty input. ${CANARY.prompt}`, "Run the tests again and fix the failure in app/main.py", "What does the scheduler do?"];
  const pytest = (decision: string, status: string, result: Obj) => ({
    name: "run_terminal_cmd", tool: 15, params: { command: "pytest -q", isBackground: false, explanation: CANARY.prompt },
    rawArgs: { command: "pytest -q", is_background: false, explanation: CANARY.prompt }, result, status, decision,
  });
  const ids = ["u1", "t1", "t2", "u2", "t3", "u3"].map(cuSid);
  const kv: Row[] = [
    [`composerData:${A}`, composer(A, { created: t0, updated: t0 + 9 * MIN, agentic: true, mode: "agent", model: CU_SONNET, headers: ids.slice(0, 5) })],
    [`composerData:${B}`, composer(B, { created: t0 + 19 * MIN, updated: t0 + 21 * MIN, agentic: false, mode: "chat", headers: ids.slice(5) })],
    [`bubbleId:${A}:${ids[0]}`, bubble(ids[0]!, { type: 1, ts: t0 + MIN, text: texts[0] })],
    [`bubbleId:${A}:${ids[1]}`, bubble(ids[1]!, {
      type: 2, ts: t0 + 2 * MIN, model: CU_GPT, thinkingMs: 900,
      tool: { ...pytest("accepted", "completed", { output: CANARY.secret, exitCodeV2: 0 }), callId: `call_t1_${CANARY.secret}` },
    })],
    [`bubbleId:${A}:${ids[2]}`, bubble(ids[2]!, {
      type: 2, ts: t0 + 3 * MIN, model: CU_GPT, error: { message: CANARY.secret, details: { title: CANARY.prompt } },
      tool: pytest("accepted", "error", { output: CANARY.secret, exitCode: 1 }),
    })],
    [`bubbleId:${A}:${ids[3]}`, bubble(ids[3]!, { type: 1, ts: t0 + 5 * MIN, text: texts[1] })],
    [`bubbleId:${A}:${ids[4]}`, bubble(ids[4]!, { type: 2, ts: t0 + 6 * MIN, tool: pytest("rejected", "cancelled", { rejected: true }) })],
    [`bubbleId:${B}:${ids[5]}`, bubble(ids[5]!, { type: 1, ts: t0 + 20 * MIN, text: texts[2] })],
    ...OTHER_KV,
  ];
  const items: Row[] = [...AUTH_ITEMS, ["aiService.prompts", [{ text: CANARY.prompt, commandType: 4 }]], ["composer.composerData", { allComposers: [{ composerId: A, name: CANARY.project }] }]];
  const globalFile = writeStateDb(h, globalRel(h), kv, items);
  const trackingFile = writeTracking(h, [
    commitRow({ hash: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0", date: new Date(t0 + 30 * MIN).toISOString(), scored: t0 + 31 * MIN, tab: 10, composer: 30, human: 5 }),
    commitRow({ hash: "0f9e8d7c6b5a0f9e8d7c6b5a0f9e8d7c6b5a0f9e", date: t0 + 40 * MIN, scored: t0 + 41 * MIN, tab: null, composer: 12, human: 40 }),
  ]);
  return { t0, globalFile, trackingFile, texts };
}

// ---- ai-code-tracking.db ----

/** `scored_commits` as described publicly (primary key commitHash, branchName); `commitMessage` and `branchName` are canaries. */
export const SCORED_COMMITS_DDL = `CREATE TABLE scored_commits (commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER, linesAdded INTEGER,
  linesDeleted INTEGER, tabLinesAdded INTEGER, tabLinesDeleted INTEGER, composerLinesAdded INTEGER, composerLinesDeleted INTEGER, humanLinesAdded INTEGER,
  humanLinesDeleted INTEGER, blankLinesAdded INTEGER, blankLinesDeleted INTEGER, commitMessage TEXT, commitDate TEXT, v1AiPercentage TEXT,
  v2AiPercentage TEXT, PRIMARY KEY (commitHash, branchName))`;

export interface CommitOpts { hash: string; branch?: string; date?: unknown; scored?: unknown; tab?: number | null; composer?: number | null; human?: number | null }

export function commitRow(o: CommitOpts): unknown[] {
  const lines = [o.tab, o.composer, o.human].map((n) => n ?? 0).reduce((a, b) => a + b, 0);
  return [o.hash, o.branch ?? CANARY.project, o.scored ?? null, lines, 0, o.tab ?? null, 0, o.composer ?? null, 0, o.human ?? null, 0, 0, 0,
    `${CANARY.prompt} fix`, o.date ?? null, "50.0", "48.5"];
}

/** The tracking database with `scored_commits` rows and the other tables Cursor keeps there (never read). */
export function writeTracking(h: FakeHome, commits: unknown[][], o: { ddl?: string; rel?: string } = {}): string {
  return h.sqlite(o.rel ?? trackingRel, [
    o.ddl ?? SCORED_COMMITS_DDL,
    "CREATE TABLE ai_code_hashes (hash TEXT PRIMARY KEY, source TEXT, fileExtension TEXT, fileName TEXT, requestId TEXT, conversationId TEXT, timestamp INTEGER, createdAt INTEGER, model TEXT)",
    "CREATE TABLE conversation_summaries (conversationId TEXT PRIMARY KEY, title TEXT, tldr TEXT, overview TEXT, summaryBullets TEXT, model TEXT, mode TEXT, updatedAt INTEGER)",
    "CREATE TABLE tracking_state (key TEXT PRIMARY KEY, value TEXT)",
  ], {
    scored_commits: commits,
    ai_code_hashes: [["abcd1234", "composer", "py", `${CANARY.path}/app.py`, `req-${CANARY.secret}`, "c1", 1, 1, "gpt"]],
    conversation_summaries: [["c1", CANARY.project, CANARY.prompt, CANARY.prompt, CANARY.code, "gpt", "agent", 1]],
    tracking_state: [["trackingStartTime", JSON.stringify({ timestamp: 1 })]],
  });
}

// ---- cursor-agent CLI stores ----

/** `~/.cursor/chats/<hash>/<agentId>/store.db`: `meta` (one hex-encoded JSON row, with a blob key) and content-addressed `blobs`. */
export function writeAgentStore(h: FakeHome, rel: string, blobs: number): string {
  const meta = Buffer.from(JSON.stringify({ agentId: cuSid("ag"), name: CANARY.project, blobEncryptionKey: CANARY.secret })).toString("hex");
  return h.sqlite(rel, ["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)", "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)"], {
    meta: [["0", meta]],
    blobs: Array.from({ length: blobs }, (_, i) => [i.toString(16).padStart(64, "0"), new TextEncoder().encode(`${CANARY.prompt} ${i}`)]),
  });
}

/** cursor-agent transcripts (JSONL by session, a subagent's, and a legacy plain-text one) and one chat store. */
export function buildAgentCli(h: FakeHome): { files: string[]; lines: number; blobs: number } {
  const s = cuSid("sess");
  const base = path.join(".cursor", "projects", "Users-canaryuser-clients-proj", "agent-transcripts");
  const line = (role: string) => ({ role, message: { content: [{ type: "text", text: `${CANARY.prompt} ${CANARY.code}` }] } });
  const files = [
    h.writeJsonl(path.join(base, s, `${s}.jsonl`), [line("user"), line("assistant"), line("user")]),
    h.writeJsonl(path.join(base, s, "subagents", "explore-1.jsonl"), [line("user"), line("assistant")]),
    h.write(path.join(base, `${cuSid("old")}.txt`), `user:\n<user_query>${CANARY.prompt}</user_query>\nA: ${CANARY.code}\n`),
    writeAgentStore(h, path.join(".cursor", "chats", "0123abcd", cuSid("ag"), "store.db"), 4),
  ];
  return { files, lines: 5, blobs: 4 };
}
