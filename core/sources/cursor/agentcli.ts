import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { safeList, safeStat, walk } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import type { RoDb } from "../../io/sqlite";
import { Tally } from "../common/coverage";
import type { Candidate, ScanCtx } from "../types";
import { q, readStore, TOOL } from "./diskkv";

export const AGENT_CLI_SOURCE = "cursor.agent-cli";
/** Transcripts: `<id>/<id>.jsonl` by session (and `<id>/subagents/*.jsonl`), or one older plain-text file per session. */
const TRANSCRIPT = /\.(?:jsonl|txt)$/;
const STORE = "store.db";

const isDir = (p: string): boolean => safeStat(p)?.isDirectory() ?? false;
const isFile = (p: string): boolean => safeStat(p)?.isFile() ?? false;

/** `<root>/projects/<project>/agent-transcripts/`: transcript files up to two folders down (session, then its subagents). */
function transcripts(root: string): string[] {
  const projects = path.join(root, "projects");
  return safeList(projects).sort().flatMap((p) => {
    const dir = path.join(projects, p, "agent-transcripts");
    return isDir(dir) ? walk(dir, { maxDepth: 2, match: (name, dirEntry) => !dirEntry && TRANSCRIPT.test(name) }).sort() : [];
  });
}

/**
 * Chat stores, `chats/<project hash>/<agent id>/store.db`, under `<home>/.cursor` and under `<config>/cursor`
 * (`$XDG_CONFIG_HOME` or `~/.config` for the scanning user, `~/.config` in other homes): the CLI has kept them in both.
 */
function chatStores(env: Env, home: string, root: string): string[] {
  const config = home === env.home ? env.xdgConfig : joinFor(env, home, ".config");
  const out: string[] = [];
  for (const chats of [path.join(root, "chats"), path.join(config, "cursor", "chats")]) {
    for (const project of safeList(chats).sort()) {
      for (const agent of safeList(path.join(chats, project)).sort()) {
        const file = path.join(chats, project, agent, STORE);
        if (isFile(file)) out.push(file);
      }
    }
  }
  return out;
}

/** `<home>/.cursor` per home (WSL homes included) where the cursor-agent CLI left transcripts or chat stores. */
export function agentCliRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = joinFor(env, home, ".cursor");
    if (transcripts(root).length > 0 || chatStores(env, home, root).length > 0) out.push({ root, home, wsl: home !== env.home });
  }
  return out;
}

/** A JSONL transcript's lines are counted, never parsed; a plain-text one is counted as a file. Counted when read to its end. */
async function countTranscript(file: string, ctx: ScanCtx, tally: Tally): Promise<void> {
  const st = safeStat(file);
  if (!st?.isFile()) return;
  if (file.endsWith(".jsonl")) {
    try {
      for await (const _line of readJsonl(file, { sniffSkip: () => true, signal: ctx.signal })) tally.records++;
    } catch {
      tally.skip("io-error");
      return;
    }
    if (ctx.signal.aborted) return;
  }
  tally.files++;
  tally.bytes += st.size;
}

/** The rows of a chat store's `blobs` (its messages, content-addressed); `meta` is never queried. */
function countBlobs(db: RoDb, tables: ReadonlySet<string>, tally: Tally): void {
  if (!tables.has("blobs")) return tally.unknownKey("missing-table:blobs");
  if (!db.columns("blobs").includes("id")) return tally.unknownKey("missing-column:id");
  const n = db.get<{ n: unknown }>(`SELECT COUNT(id) AS n FROM ${q("blobs")}`)?.n;
  if (typeof n === "number") tally.records += n;
}

/**
 * Scan one `.cursor` folder's cursor-agent stores (beta): transcripts and chat stores are counted and sized, never
 * decoded — their formats are not documented well enough to map. One CoverageEv, `present-undecodable`, no events.
 */
export async function scanAgentCli(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, AGENT_CLI_SOURCE);
  for (const file of transcripts(c.root)) {
    if (ctx.signal.aborted) break;
    await countTranscript(file, ctx, tally);
  }
  for (const file of chatStores(ctx.env, c.home, c.root)) {
    if (ctx.signal.aborted) break;
    readStore(file, ctx, tally, (db, tables) => countBlobs(db, tables, tally));
  }
  const cov = tally.coverage();
  cov.status = "present-undecodable";
  ctx.emit(cov);
}
