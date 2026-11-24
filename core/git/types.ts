import type { CheckKind } from "../model/ids";

/** An AI tool named by a commit's trailers (`classifyCommit`). */
export type AiTool = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "antigravity" | "aider" | "other";
/** An instruction file kind: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`. */
export type InstructionKind = "claude" | "agents" | "gemini" | "cursorrules" | "cursor-rules";

/**
 * One commit of the person's own (author email = the repo's `user.email`), as keyed facts: its commit time (epoch ms),
 * the keyed hash of its sha's first 7 hex digits lower-cased (the key a Claude Code `commit` marker gives the same
 * commit), the AI co-author or generated-with trailer it names, whether its subject marks rework, and the keyed hashes
 * of the paths it changed (capped). The message itself is never kept.
 *
 * `owner`: the same commit can sit in several repos (clones, forks): every repo lists it, and it is the owner's in
 * exactly one — the repo with the most detail-window sessions, then the smallest repoKey (compared by full sha, in
 * memory only). Whole-report totals count owner commits only; per-repo matching (delivery, rework, file history) may
 * use all of a repo's commits.
 *
 * `id`: a keyed hash (16 lowercase hex digits) of the commit's full sha: equal for the same commit in every clone of one
 * repository within one scan, never the sha itself. Repo signals set it on every commit; it is optional in the type only
 * for facts made elsewhere (tests, synthetic personas).
 *
 * `mine`: the commit's author is the person (author email = the repo's `user.email`, the rule that decides which commits
 * are listed at all): true in every clone that lists the commit, unlike `owner`. Deciding "once" among the repos in
 * scope is the analysis's job, by `id`.
 */
export interface CommitFact { id?: string; ts: number; shaKey: string; ai?: AiTool; generated?: AiTool; rework?: "revert" | "fixup" | "fix"; files: string[]; owner: boolean;
  mine: boolean }
export interface InstructionFacts { files: InstructionKind[]; namesChecks: CheckKind[]; touched: number; lastTouched?: number }
/** `.claude/settings.json` hooks: the entries there, the checks their commands run, and `disableAllHooks` (then none runs, and `checks` is empty). */
export interface HookFacts { entries: number; checks: CheckKind[]; disabled: boolean }
export interface CheckFacts { present: boolean; checks: CheckKind[] }

/**
 * One repository found from session folders. `repoKey` = keyedHash(salt, normalizePath(root)); `projectKeys`: the
 * session projects inside it; `identity`: the repo has a `user.email`, so the person's commits can be told apart (none
 * are read without it); `commitsTruncated`: the history held more commits than were read (`maxCommits`, the output
 * cap, or a timeout that ended the log); `commitsReach`: set when the commit list was cut short (the commit cap, the
 * output cap or a timeout) — the smallest commit time (epoch ms) among the records read, any author's (the scan's `now`
 * when none was read): sessions before it cannot be matched to commits; absent when the list is complete back to the
 * time asked for; `fileLists`: changed paths were read (false for a partial clone read without them, where rework is not
 * measurable). `instructions`, `hooks`, `ci` and `precommit` come from the repo's allowlisted files, read from the
 * worktree the most detail-window sessions ran in (`readRepoFiles`).
 */
export interface RepoFacts { repoKey: string; projectKeys: string[]; identity: boolean; commits: CommitFact[]; commitsTruncated: boolean; commitsReach?: number; fileLists: boolean;
  instructions: InstructionFacts; hooks: HookFacts; ci: CheckFacts; precommit: CheckFacts }

/**
 * What repo signals found. `status`: `ok`; `partial` (a read did not finish: the time budget ran out, the scan was
 * aborted, or a timeout or error dropped a repo or cut its data — any count of `budget`, `timeout`, `error`,
 * `identity-error`, `log-error`, `files-error` or `file-io-error` in `skipped`); `off` (switched off); `git-missing` (no
 * git to run: none on PATH, or `git --version` failed, timed out or named no version). `roots`: repoKey → the raw root
 * path, held in memory only (for the repo-file pass and display on this machine) and never part of an analysis or an
 * export. `skipped`: session folders or repos left out, by reason (`not-absolute` (a session folder not named by an absolute path), `missing`, `not-a-repo`, `root-mismatch` (the root
 * git reports is not the session's repo folder itself, or its answer is malformed), `too-many-repos`, `budget`,
 * `timeout`, `error`, `identity-error` (`user.email` could not be read: the repo is listed without commits),
 * `log-error` (the commit log failed: the repo is listed without commits)), and repo files left unread (`file-not-file`, `file-too-large`, `file-refused`, `file-io-error`,
 * `file-parse`, `file-outside`, `files-capped`, `folders-capped`: `readRepoFiles`; `files-error`: a files pass that failed, the repo's
 * commits kept). `since`: the earliest commit time asked for (epoch ms). `ms`: time taken.
 */
export interface RepoSignals { status: "ok" | "partial" | "off" | "git-missing"; repos: RepoFacts[]; roots: Map<string, string>;
  skipped: Record<string, number>; since?: number; ms: number }
