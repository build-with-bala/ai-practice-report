// Synthetic Antigravity stores. Table, column and JSON field names follow the stores' structure as FORMAT.md records it
// (confirmed with the structure probe); protobuf field numbers and enum numbers follow the Antigravity programs' own type
// tables (see FORMAT.md) and are written out here independently of the reader — except the trajectory summary, which is
// encoded with the reader's `TRAJ_FIELDS` (pinned to the program's numbers by a test). Every value is invented.
import { Database } from "bun:sqlite";
import path from "node:path";
import { vscodeUser } from "../../core/env/paths";
import { TRAJ_FIELDS } from "../../core/sources/antigravity/ide";
import { CANARY } from "../kit/canary";
import type { FakeHome } from "../kit/home";
import { pbEncode } from "../kit/pb";
import { fixtureStart, MIN } from "./claude-code";

type Obj = Record<string, unknown>;
type PbList = Parameters<typeof pbEncode>[0];

/** A UUID-shaped (version 4) conversation id derived from a short label of ≤ 6 ASCII characters. */
export function agId(label: string): string {
  return `00000000-0000-4000-8000-${Buffer.from(label, "latin1").toString("hex").padStart(12, "0").slice(-12)}`;
}

export const CLI_REL = path.join(".gemini", "antigravity-cli");
export const IDE_BRAIN_REL = path.join(".gemini", "antigravity", "brain");
export const CLI_BRAIN_REL = path.join(CLI_REL, "brain");
export const summariesRel = path.join(CLI_REL, "conversation_summaries.db");
export const stepsRel = (id: string): string => path.join(CLI_REL, "conversations", `${id}.db`);
export const transcriptRel = (id: string): string => path.join(CLI_BRAIN_REL, id, ".system_generated", "logs", "transcript.jsonl");
export const historyRel = path.join(CLI_REL, "history.jsonl");
/** Home-relative `globalStorage/state.vscdb` of an Antigravity app (`vscodeUser(env, app)`), whatever the platform. */
export const ideRel = (h: FakeHome, app = "Antigravity"): string =>
  path.join(path.relative(h.env.home, vscodeUser(h.env, app)), "globalStorage", "state.vscdb");

/** Creates a store with `ddl` and inserts the rows of each table in one transaction (one sync: large stores stay quick everywhere). */
function writeDb(h: FakeHome, rel: string, ddl: string[], rows: Record<string, unknown[][]>): string {
  const file = h.sqlite(rel, ddl);
  const db = new Database(file);
  try {
    db.transaction(() => {
      for (const [table, list] of Object.entries(rows)) {
        for (const r of list) db.query(`INSERT INTO "${table}" VALUES (${r.map(() => "?").join(", ")})`).run(...(r as never[]));
      }
    })();
  } finally {
    db.close();
  }
  return file;
}

/** The time format a Go SQLite driver writes for a Go `time.Time` (`2006-01-02 15:04:05.999999999-07:00`), here in UTC. */
export const goTime = (ms: number): string => new Date(ms).toISOString().replace("T", " ").replace("Z", "000000+00:00");
/** Go's zero `time.Time`, which a `not null` time column holds when the CLI never set it. */
export const GO_ZERO_TIME = "0001-01-01 00:00:00+00:00";

// ---- conversation_summaries.db ----

/** The summaries table with the column names and declared types the structure probe showed. */
export const SUMMARIES_DDL = `CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
  step_count INTEGER NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '', agent_name TEXT NOT NULL DEFAULT '', parent_conversation_id TEXT NOT NULL DEFAULT '',
  nesting_depth INTEGER NOT NULL DEFAULT 0, battle_id TEXT NOT NULL DEFAULT '', winning_conversation_id TEXT NOT NULL DEFAULT '',
  not_fully_idle numeric NOT NULL DEFAULT false, killed numeric NOT NULL DEFAULT false, last_user_input_time datetime NOT NULL,
  last_user_input_step_index INTEGER NOT NULL DEFAULT -1, app_data_dir TEXT NOT NULL DEFAULT '', raw_summary BLOB, group_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (conversation_id))`;

export interface SummaryOpts {
  id: string; steps?: number; modified?: number | string; input?: number | string; workspaces?: unknown; parent?: string; depth?: number;
  battle?: string; winner?: string; killed?: boolean; source?: string;
}

/** One `conversation_summaries` row; every text column the reader must never select holds a canary. */
export function summaryRow(o: SummaryOpts): unknown[] {
  const time = (v: number | string | undefined) => (typeof v === "number" ? goTime(v) : v ?? GO_ZERO_TIME);
  const workspaces = typeof o.workspaces === "string" ? o.workspaces : JSON.stringify(o.workspaces ?? [`file://${CANARY.path}`]);
  return [
    o.id, `${CANARY.prompt} title`, `${CANARY.code} preview`, o.steps ?? 4, time(o.modified), workspaces, "CASCADE_RUN_STATUS_IDLE",
    o.source ?? "CORTEX_TRAJECTORY_SOURCE_CLI", `${CANARY.project}-project`, `${CANARY.project} agent`, o.parent ?? "", o.depth ?? 0, o.battle ?? "",
    o.winner ?? (o.battle ? `${CANARY.secret}-winner` : ""), 0, o.killed ? 1 : 0, time(o.input), 3, CANARY.path,
    pbEncode([[1, `${CANARY.prompt} summary`], [2, 4], [4, CANARY.secret]]), `${CANARY.project}-group`,
  ];
}

export function writeSummaries(h: FakeHome, rows: SummaryOpts[], o: { ddl?: string } = {}): string {
  return writeDb(h, summariesRel, [o.ddl ?? SUMMARIES_DDL], { conversation_summaries: rows.map(summaryRow) });
}

// ---- conversations/<id>.db ----

/** `CortexStepType` numbers (the CLI program's enum). */
export const STEP = {
  FINISH: 2, CODE_ACTION: 5, GIT_COMMIT: 6, GREP_SEARCH: 7, VIEW_FILE: 8, LIST_DIRECTORY: 9, COMPILE: 10, USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17,
  RUN_COMMAND: 21, CHECKPOINT: 23, FIND: 25, COMMAND_STATUS: 28, SEARCH_WEB: 33, MCP_TOOL: 38, OPEN_BROWSER_URL: 56, CLICK_BROWSER_PIXEL: 64,
  TASK_BOUNDARY: 81, NOTIFY_USER: 82, BROWSER_SUBAGENT: 85, FILE_CHANGE: 86, EPHEMERAL_MESSAGE: 90, GENERATE_IMAGE: 91, SYSTEM_MESSAGE: 101,
  WAIT: 102, BLAZE_TEST_TARGETS: 107, SHELL_EXEC: 112, LINT_APPLET: 114, EDIT_NOTEBOOK: 126, INVOKE_SUBAGENT: 127, GENERIC: 132,
  ASK_QUESTION: 138, TOOL_SEARCH: 140,
} as const;
/** `CortexStepStatus` numbers. */
export const STATUS = { RUNNING: 2, DONE: 3, CANCELED: 6, ERROR: 7, INTERRUPTED: 12 } as const;

/** The steps table and the conversation store's other tables (never read), as the structure probe showed them. */
export const STEPS_DDL = `CREATE TABLE steps (idx INTEGER, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0,
  has_subtrajectory numeric NOT NULL DEFAULT false, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB,
  step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx))`;
const OTHER_TABLES = [
  "CREATE TABLE battle_mode_infos (idx INTEGER, data BLOB, PRIMARY KEY (idx))",
  "CREATE TABLE executor_metadata (idx INTEGER, data BLOB, PRIMARY KEY (idx))",
  "CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER, PRIMARY KEY (idx))",
  "CREATE TABLE parent_references (idx INTEGER, data BLOB, PRIMARY KEY (idx))",
  "CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)",
  "CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)",
];

/** A `google.protobuf.Timestamp` (seconds, nanos). */
export const pbTs = (ms: number): Uint8Array => pbEncode([[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1_000_000]]);

/**
 * A step's `metadata` (`CortexStepMetadata`): created (1) and completed (8) times, and in between the fields the reader must
 * never keep — its tool call (4: id, name, arguments JSON) and tool summary (30).
 */
export function stepMetadata(ms: number, tool = "run_command", args: unknown = { CommandLine: CANARY.code, Cwd: CANARY.path }): Uint8Array {
  const call = pbEncode([[1, `call-${CANARY.secret}`], [2, tool], [3, typeof args === "string" ? args : JSON.stringify(args)]]);
  return pbEncode([[1, pbTs(ms)], [3, 2], [4, call], [8, pbTs(ms + 1_500)], [30, `${CANARY.prompt} summary`]]);
}

/**
 * A run-command payload (`CortexStepRunCommand`: 23 command line, 2 cwd, 4 stdout, 6 exit code — left out here for 0, 14 user
 * rejected), or the step wrapping it as field 28 (`run_command`) next to its type (1) and status (4).
 */
export function runPayload(o: { cmd?: string; exit?: number; wrapped?: boolean; rejected?: boolean }): Uint8Array {
  const fields: PbList = [];
  if (o.cmd !== undefined) fields.push([23, o.cmd]);
  fields.push([2, CANARY.path], [4, `${CANARY.secret} output`]);
  if (o.exit !== undefined && o.exit !== 0) fields.push([6, o.exit]);
  if (o.rejected) fields.push([14, 1]);
  const rc = pbEncode(fields);
  return o.wrapped ? pbEncode([[1, STEP.RUN_COMMAND], [4, STATUS.DONE], [28, rc]]) : rc;
}

export interface StepOpts { type: number; status?: number; ts?: number; error?: boolean; payload?: Uint8Array | null; metadata?: Uint8Array | string | null }

/** One `steps` row; error details, permissions, task details, render info and every payload but a command's hold canaries. */
export function stepRow(idx: number, o: StepOpts): unknown[] {
  const metadata = o.metadata !== undefined ? o.metadata : o.ts === undefined ? null : stepMetadata(o.ts);
  const payload = o.payload !== undefined ? o.payload : pbEncode([[1, `${CANARY.code} file content`], [2, CANARY.path]]);
  return [
    idx, o.type, o.status ?? STATUS.DONE, 0, metadata, o.error ? pbEncode([[1, `${CANARY.secret} failed`], [3, CANARY.code]]) : null,
    pbEncode([[1, CANARY.path]]), pbEncode([[1, CANARY.prompt]]), pbEncode([[1, CANARY.project]]), payload, 0,
  ];
}

export function writeSteps(h: FakeHome, id: string, steps: StepOpts[], o: { ddl?: string } = {}): string {
  return writeDb(h, stepsRel(id), [o.ddl ?? STEPS_DDL, ...OTHER_TABLES], {
    steps: steps.map((s, i) => stepRow(i, s)),
    gen_metadata: [[0, pbEncode([[1, CANARY.prompt], [2, CANARY.code]]), 9]],
    trajectory_meta: [[`${CANARY.secret}-trajectory`, id, 4, 17]],
    trajectory_metadata_blob: [[id, pbEncode([[5, CANARY.secret], [7, `file://${CANARY.path}`]])]],
  });
}

// ---- transcript.jsonl and history.jsonl ----

export interface RecordOpts {
  step: number; type: string; source: string; ts?: number; content?: unknown; tokens?: { input?: number; output?: number; cacheRead?: number };
  media?: string[]; extra?: Obj;
}

/** One transcript record; model replies, thinking, tool calls, errors and media hold canaries. */
export function record(o: RecordOpts): Obj {
  const r: Obj = { step_index: o.step, type: o.type, source: o.source, status: "DONE", content: o.content ?? `${CANARY.code} reply` };
  if (o.ts !== undefined) r.created_at = new Date(o.ts).toISOString();
  if (o.type === "PLANNER_RESPONSE") {
    r.thinking = `${CANARY.prompt} thinking`;
    r.tool_calls = [{ name: "run_command", args: { CommandLine: CANARY.code, Cwd: CANARY.path, toolAction: CANARY.prompt, toolSummary: CANARY.prompt } }];
  }
  if (o.tokens?.input !== undefined) r.input_tokens = o.tokens.input;
  if (o.tokens?.output !== undefined) r.output_tokens = o.tokens.output;
  if (o.tokens?.cacheRead !== undefined) r.cache_read_tokens = o.tokens.cacheRead;
  if (o.media) r.media = o.media.map((mime) => ({ mime_type: mime, uri: `file://${CANARY.path}/upload` }));
  return { ...r, ...o.extra };
}

export const userInput = (step: number, ts: number | undefined, content: unknown, extra: Partial<RecordOpts> = {}): Obj =>
  record({ step, type: "USER_INPUT", source: "USER_EXPLICIT", ts, content, ...extra });
export const modelReply = (step: number, ts: number, tokens: RecordOpts["tokens"]): Obj =>
  record({ step, type: "PLANNER_RESPONSE", source: "MODEL", ts, tokens });

export const historyLine = (o: { display?: unknown; timestamp?: unknown; conversationId?: string; type?: string }): Obj => ({
  ...(o.display !== undefined && { display: o.display }), ...(o.timestamp !== undefined && { timestamp: o.timestamp }),
  ...(o.conversationId !== undefined && { conversationId: o.conversationId }), workspace: CANARY.path, ...(o.type !== undefined && { type: o.type }),
});

// ---- the IDE's state.vscdb ----

export const ITEM_DDL = "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)";
export const TRAJ_KEY = "antigravityUnifiedStateSync.trajectorySummaries";
export type Item = [string, unknown];
/** The account rows beside the trajectories in the same `ItemTable`: never selected. */
export const AUTH_ITEMS: Item[] = [
  ["antigravityUnifiedStateSync.oauthToken", CANARY.token],
  ["antigravityAuthStatus", JSON.stringify({ name: CANARY.project, email: CANARY.email, apiKey: CANARY.secret })],
  ["antigravityUnifiedStateSync.userStatus", JSON.stringify({ email: CANARY.email })],
];

export interface TrajectoryOpts { id?: string; steps?: number; created?: number; updated?: number; workspace?: string }

/**
 * One `CascadeTrajectorySummary`, encoded with `TRAJ_FIELDS` — plus its title (1), status (5), latest steps, annotations and
 * trajectory metadata (17), which hold canaries and must never be kept.
 */
export function trajectory(o: TrajectoryOpts): Uint8Array {
  const f: PbList = [[1, `${CANARY.prompt} title`]];
  if (o.steps !== undefined) f.push([TRAJ_FIELDS.steps, o.steps]);
  if (o.updated !== undefined) f.push([TRAJ_FIELDS.updated, pbTs(o.updated)]);
  if (o.id !== undefined) f.push([TRAJ_FIELDS.id, o.id]);
  f.push([5, 1]);
  if (o.created !== undefined) f.push([TRAJ_FIELDS.created, pbTs(o.created)]);
  if (o.workspace !== undefined) f.push([TRAJ_FIELDS.workspace, pbEncode([[1, o.workspace], [2, o.workspace], [4, `${CANARY.project}-branch`]])]);
  f.push([12, pbEncode([[1, 7], [2, pbEncode([[1, CANARY.secret]])]])], [15, pbEncode([[1, CANARY.prompt]])]);
  f.push([17, pbEncode([[5, CANARY.secret], [7, `file://${CANARY.path}`]])]);
  return pbEncode(f);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
/** The unified-state-sync topic: entries {1: key, 2: Row {1: value — the base64 summary}}, the whole topic base64 text. */
export function topic(entries: { key: string; summary: Uint8Array | string }[]): string {
  const entry = (e: { key: string; summary: Uint8Array | string }) =>
    pbEncode([[1, e.key], [2, pbEncode([[1, typeof e.summary === "string" ? e.summary : b64(e.summary)], [2, 3]])]]);
  return b64(pbEncode(entries.map((e): [number, Uint8Array] => [1, entry(e)])));
}

export function writeIdeStore(h: FakeHome, rel: string, items: Item[], o: { ddl?: string } = {}): string {
  const file = h.sqlite(rel, [o.ddl ?? ITEM_DDL]);
  const db = new Database(file);
  try {
    db.transaction(() => {
      const st = db.query("INSERT INTO ItemTable VALUES (?, ?)");
      for (const [k, v] of items) st.run(k, v as never);
    })();
  } finally {
    db.close();
  }
  return file;
}

// ---- brain artifacts ----

/** Writes `<brain>/<id>/<name>` files (their content is a canary: the reader never opens them). */
export function writeBrain(h: FakeHome, brainRel: string, id: string, names: string[]): string[] {
  return names.map((n) => h.write(path.join(brainRel, id, n), `# ${CANARY.prompt}\n${CANARY.code}\n`));
}

// ---- the Task 15 scenario ----

export const P = agId("P");
export const C = agId("C");
export const K = agId("K");
export const I1 = agId("I1");
export const I2 = agId("I2");

export interface AgFixture { t0: number; texts: string[]; summariesFile: string; stepsFile: string; ideFile: string }

/**
 * Summaries: P (human, its workspace a canary path), C (subagent of P, nesting depth 1), K (killed). `conversations/<P>.db`:
 * five tool steps — a code action, a run command, a file view, a search (with error details) and a browser step. P's
 * transcript: two USER_EXPLICIT inputs (the first holding `CANARY.prompt`), two model replies with tokens and a code action
 * record. The IDE store: two trajectories and the account rows. The IDE brain: `task.md` and `implementation_plan.md` of I1.
 */
export function buildAntigravity(h: FakeHome): AgFixture {
  const t0 = fixtureStart();
  const texts = [`Make the importer reject empty input. ${CANARY.prompt}`, "Now add a test for the importer"];
  const summariesFile = writeSummaries(h, [
    { id: P, steps: 9, input: t0 + 10 * MIN, modified: t0 + 20 * MIN, workspaces: [`file://${CANARY.path}/app`] },
    { id: C, steps: 3, parent: P, depth: 1, input: t0 + 6 * MIN, modified: t0 + 8 * MIN },
    { id: K, steps: 2, killed: true, input: t0 + 30 * MIN, modified: t0 + 31 * MIN },
  ]);
  const stepsFile = writeSteps(h, P, [
    { type: STEP.CODE_ACTION, ts: t0 + 2 * MIN },
    { type: STEP.RUN_COMMAND, ts: t0 + 3 * MIN, payload: runPayload({ cmd: "./scripts/deploy.sh --dry-run" }) },
    { type: STEP.VIEW_FILE, ts: t0 + 4 * MIN },
    { type: STEP.GREP_SEARCH, ts: t0 + 5 * MIN, status: STATUS.ERROR, error: true },
    { type: STEP.OPEN_BROWSER_URL, ts: t0 + 6 * MIN },
  ]);
  h.writeJsonl(transcriptRel(P), [
    userInput(0, t0 + MIN, texts[0]),
    modelReply(1, t0 + MIN + 30_000, { input: 1200, output: 300, cacheRead: 9000 }),
    record({ step: 2, type: "CODE_ACTION", source: "MODEL", ts: t0 + 2 * MIN }),
    userInput(3, t0 + 10 * MIN, texts[1]),
    modelReply(4, t0 + 11 * MIN, { input: 800, output: 120 }),
  ]);
  const ideFile = writeIdeStore(h, ideRel(h), [
    ...AUTH_ITEMS,
    [TRAJ_KEY, topic([
      { key: I1, summary: trajectory({ id: agId("t1"), steps: 5, created: t0 + 40 * MIN, updated: t0 + 50 * MIN, workspace: `file://${CANARY.path}/web` }) },
      { key: I2, summary: trajectory({ id: agId("t2"), steps: 2, created: t0 + 60 * MIN, updated: t0 + 61 * MIN }) },
    ])],
  ]);
  writeBrain(h, IDE_BRAIN_REL, I1, ["task.md", "implementation_plan.md"]);
  return { t0, texts, summariesFile, stepsFile, ideFile };
}
