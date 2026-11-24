import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { isDir, safeStat } from "../../io/fs";
import { toEpochMs } from "../../io/time";
import type { MarkerEv } from "../../model/events";
import { listDir, Tally } from "../common/coverage";
import type { Candidate, ScanCtx } from "../types";
import { agSessionId, TOOL } from "./ids";

export const BRAIN_SOURCE = "antigravity.brain";
/** The plan artifacts the agent keeps in a conversation's brain folder, `<name>.md`: checked for existence, never opened. */
export const ARTIFACTS = ["task", "implementation_plan", "walkthrough"] as const;

/** The IDE's `<home>/.gemini/antigravity/brain` and the CLI's `<home>/.gemini/antigravity-cli/brain`, per home (WSL homes included). */
export function brainRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    for (const root of [joinFor(env, home, ".gemini", "antigravity", "brain"), joinFor(env, home, ".gemini", "antigravity-cli", "brain")]) {
      if (isDir(root)) out.push({ root, home, wsl: home !== env.home });
    }
  }
  return out;
}

/**
 * Scan one brain folder: `<root>/<conversation>/{task,implementation_plan,walkthrough}.md` → a `plan-artifact` MarkerEv per
 * regular file present, `detail` = its name, `ts` = its last modification, `sessionId` = the conversation (the folder's name:
 * a UUID verbatim, else its keyed hash). Only `lstat` is used: the files are never opened. One CoverageEv (window `lifetime`), last.
 */
export async function scanBrain(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, BRAIN_SOURCE, "lifetime");
  for (const name of listDir(c.root, tally)) {
    if (ctx.signal.aborted) break;
    if (name.startsWith(".")) continue;
    for (const detail of ARTIFACTS) {
      const st = safeStat(path.join(c.root, name, `${detail}.md`));
      if (!st?.isFile()) continue;
      const ts = toEpochMs(Math.floor(st.mtimeMs), ctx.now);
      if (ts === undefined) {
        tally.noTime(Math.floor(st.mtimeMs));
        continue;
      }
      tally.records++;
      // the file's modification time stands in for when the artifact was written: it is never activity of its own
      const m: MarkerEv = { k: "marker", tool: TOOL, source: BRAIN_SOURCE, ts, sessionId: agSessionId(name, ctx), kind: "plan-artifact", detail, proxyTs: true };
      ctx.emit(m);
      tally.span(ts);
    }
  }
  ctx.emit(tally.coverage());
}
