# AI Leverage Suite v2 — Design

**Date:** 2026-11-17 · **Status:** draft, awaiting approval · **Owner:** Balaji (CTO & co-founder, Neosophical Labs)
**Products:** A = `build-with-bala/ai-candidate-profiler` v2.0.0 (hiring) · B = `build-with-bala/ai-practice-report` v1.0.0 (developer-first, hosts the shared core)
**Inputs:** v1.5.0 source; five parallel brainstorm reports (trace sources, scoring, trust/privacy, hiring workflow + market, report design). Their measurements on real traces from this machine are cited as "[measured]".

---

## 0. TL;DR

```
                 ┌───────────────────────── B: ai-practice-report (public, MIT) ─────────────────────────┐
                 │  core/  ── the open engine both products compile in                                   │
 local traces ──►│  sources(20 tools) → events → signals → scoring(7 dims ± CI) → forensics → privacy    │
 (read-only)     │                                                      │                                │
                 │  app/   ── "AI Practice Report": private growth report, coach, history, share card    │
                 └──────────────────────────────────────────────────────┼────────────────────────────────┘
                                                                        │ pinned commit SHA
                 ┌───────────────────── A: ai-candidate-profiler (public, MIT) ───────────────────────────┐
                 │  invite → consent preview → sign (+seal, +timestamp) → .aiprof → verify → dossier      │
                 │  interview kit · pairing-session recorder · compare console · role profiles · calibrate│
                 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

- v1 cannot be patched: on current tool versions most of its numbers are wrong (it misses 54% of Claude Code tool calls, all Copilot chats since Feb 2026, ~98% of Codex shell commands, and counts machine-inserted text as the candidate's prompts). Scores saturate (this machine: 94, three axes at 100). The report is editable and leaks hostname/email/project names.
- v2 rebuilds the engine once (in B), measures **how well** people work with agents (7 dimensions with confidence intervals, no ceiling), is **private by construction**, and gives A a **trust stack** (signed, invite-bound, forensically checked bundles that the recruiter verifies and renders with their own viewer).
- Both products are fully offline by default, ship as single-file executables for 5 OS/arch targets, and produce single self-contained HTML reports.

---

## 1. Intent and why

The owner hires engineers who are expected to work AI-natively. Interviews and take-homes show one hour in a blank environment; they cannot show months of real practice, the person's own setup, or whether they verify what agents produce. Local agent traces can. v1 proved the idea but cannot be trusted: wrong counts, saturated scores, an editable result file, and privacy claims that are false.

- **A** exists so a hiring manager can make a better, fairer, faster decision: evidence they can trust, comparable across candidates, wired into the interview, and safe for candidates to share.
- **B** exists so individual developers get a report they *want* to run and keep (how their practice is evolving, what to try next). It is the public, open face of the engine (Build with Bala brand) and the reason candidates arrive already familiar with it. Open source also lets any candidate audit exactly what is read — the antidote to "run this binary a recruiter sent you", which is a known malware-lure pattern.

**Market gap [brainstorm, cited in notes]:** sandbox assessments (HackerRank, CodeSignal, CoderPad, Codility) see one session in a stock environment; self-insight tools (Claude Code `/insights`, ccusage, vibe-log, wrapped cards) are private and single-tool; employer analytics (Claude Code Analytics API, Copilot metrics, DX) stay with the employer. Nobody turns months of cross-tool local practice into consented, comparable hiring evidence.

---

## 2. Goals, non-goals, anti-goals

**Goals**
1. **Correct measurement** on late-2026 formats for 20 tools (P0: Claude Code, Codex, Copilot, Cursor, Antigravity; P1: Gemini CLI, OpenCode, Cline/Roo/Kilo; P2 beta: Windsurf/Devin Desktop, Zed, Kiro, Warp, Amp, Goose, Factory Droid, Qwen Code, Crush, Aider, Continue, JetBrains AI/Junie).
2. **Skill, not volume:** dimensions that discriminate at the top end, admit uncertainty (intervals, evidence minimums), and are traceable to their components.
3. **Private by construction:** an allowlisted export schema, a consent preview of every shared byte, an accurate privacy statement, no secrets ever opened.
4. **(A) Trustworthy results:** edits are detectable, runs are bound to an invite, faked or transplanted history is flagged, and the recruiter never opens candidate-supplied HTML.
5. **(A) Decision support:** role-fit against a role profile, an interview kit generated from gaps, a live pairing-session recorder, an offline compare console, and a calibration loop.
6. **(B) A report worth keeping:** trajectory, month-over-month diffs, concrete upgrade recipes, an opt-in coach that uses the developer's own agent CLI, a share card, and an employer export.
7. **Awwwards-tier reports:** the "assay certificate" visual system, light/dark, real print-to-PDF, accessible, mobile-correct.
8. **Fast and bounded:** streaming everywhere; a full scan of this machine (2.4 GB Claude Code + 5.4 GB Codex) in ≤ 60 s cold, peak RSS ≤ 1 GB.

**Non-goals (this round)**
- A hosted hiring platform, accounts, or uploads (a zero-knowledge drop-box is a stretch item, §11 P6).
- Learned ML models in the binary (rules-based classifiers ship; a learned intent model is stretch).
- Code-signing/notarization certificates (needs the owner's Apple/Authenticode certs; provenance attestations ship instead).
- Population percentiles (no consented population data exists yet).

**Anti-goals (would make it a failure even if it works)**
- A hire/no-hire recommendation, or ranking candidates by one number (NYC LL144 / EU AI Act exposure; also just wrong).
- Any network request by default; any opt-in network use that sends more than a hash.
- Opening, reading, or exporting credentials/tokens/API keys; exporting prompt text, code, file contents, paths, hostnames, usernames, emails, or real project/client names (unless the candidate reveals a project name explicitly).
- Working-hours/late-night "risk" signals (proxy for timezone, caregiving, religion, disability).
- Scores that look certain on thin data; flattering boilerplate ("100% match"); vanity trophies (token counts as achievements).
- Silent zeros when a format changes (must surface "format changed?").
- Privacy or trust claims that overstate what the code does.

---

## 3. Constraints

- **Runtime/build:** Bun ≥ 1.3 (local 1.3.11), TypeScript, `bun build --compile` for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`. No native addons. Reports are one HTML file each: inline CSS/JS/fonts, no external requests, CSP meta `default-src 'none'` plus the inline/data: allowances needed.
- **Verified locally (2026-11-17):** `bun:sqlite` opens `file:<path>?mode=ro` URIs and reads uncheckpointed WAL data; `?immutable=1` does **not** see WAL data (use `mode=ro`). `node:crypto` Ed25519 sign/verify works in Bun.
- **Data handling:** repos contain synthetic fixtures only — never real traces. Raw text exists only in memory inside a source plugin; events carry no free-text fields.
- **Repos:** B is new (`build-with-bala/ai-practice-report`, name verified available) and **public from day one** (owner), so CI runs the full ubuntu/macos/windows matrix for free. A is the existing repo. A imports B's core **pinned by commit SHA** (the tag is recorded alongside for readability), so a moved tag can never swap the core underneath A; during local development A may point at B's checkout via a `file:` path, but A's CI always uses the pinned SHA from GitHub.
- **GitHub account hygiene:** the owner confirmed on 2026-11-17 that the Aug 2026 build-with-bala token compromise is remediated (tokens rotated). Releases therefore build in GitHub Actions, but defensively: release jobs run only in a protected `release` environment that requires the owner's approval per run, `v*` tags are protected by a ruleset, workflows pin third-party actions by SHA, and every artifact gets a build-provenance attestation.
- **Build-time inspection of real traces (my call):** while building, agents may inspect the *structure* of this machine's traces — keys, types, record-type histograms, protobuf field numbers/wire types, counts — exactly as the brainstorm did; never values, never content. Fixtures copy shapes, never data.
- **Org rules (from workspace CLAUDE.md):** feature branches + PRs (Claude opens and merges); run the EtherHiding config scan before every push/pull/server start; commits end with the Co-Authored-By trailer; author identity = global git config.
- **Legal posture:** evidence + human rubric; the tool never decides.
- **Honest trust limits:** the candidate owns the machine; anything embedded in a client binary can be extracted. Signing gives tamper-*evidence*; forensics raise the cost of fabrication; only the live walkthrough/pairing ties evidence to a person. The product must say exactly this.
- **Environments the builder cannot test locally:** Cursor, Windows, WSL, and all P2 tools — covered by synthetic fixtures built from public format docs, CI on all three OSes, and "beta" labelling until verified on real data.

---

## 4. Approaches considered

| Decision | Options | Picked | Why |
|---|---|---|---|
| Direction | A hiring-grade · B developer-first · C hosted hiring console | **A + B, both "very advanced"** (owner) | A fixes the fatal flaw for hiring; B gives candidates a reason to run it and is the public brand face. C makes the owner custodian of candidate data with legal exposure, premature at 2 downloads. |
| Repos | one repo · separate repos | **Separate** (owner) | Different audiences, release cadences, and brands. |
| Shared core | inside B · third repo · copy in each | **Inside B** (owner) | Two repos only; the open core lets candidates audit what is read; format fixes land once (Claude Code alone shipped 33 versions in 75 days on this machine [measured]). Cost: A pins B's tag and bumps it per fix. |
| Repo homes | A here + B new · A private in company org · this repo becomes B | **A here, B new** (owner) | Candidates must be able to download A's releases; private-repo releases aren't downloadable. |
| Engine shape | patch v1 · rewrite as plugin engine | **Rewrite** (builder rec.) | v1's single-pass scanners can't express origin, subagent attribution, two time layers, or drift detection. |
| Trust | none · signature only · layered (sign + bind + forensics + live) | **Layered** | Signature alone stops edits, not fabrication; forensics anchored to server-minted IDs are feasible [measured]; the live step is the only person-binding. |

---

## 5. System overview

```
                        CANDIDATE / DEVELOPER MACHINE (offline)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ locate ──► fingerprint ──► scan (stream)          ┌──────────── core (B) ──────────────┐ │
│ per-OS paths,  version,     JSONL line-stream,    │ events (no free text)              │ │
│ env overrides, record-type  SQLite ?mode=ro,      │   Session · Prompt(origin,intent)  │ │
│ WSL roots      histogram,   protobuf-lite,        │   ToolCall(cat,ok,ms) · Usage      │ │
│                retention    per-line caps         │   Edit · Config(used?) · Coverage  │ │
│                             text→features in mem ─┤        │                           │ │
│                                                   │ aggregate store (per session/ep.)  │ │
│                                                   │        │                           │ │
│                                                   │ signals ─► scoring ─► forensics    │ │
│                                                   │        (7 dims ± CI, exposure)     │ │
│                                                   │                 │                  │ │
│                                                   │ privacy: allowlist export schema   │ │
│                                                   └─────────────────┬──────────────────┘ │
│              ┌──────────────────────────────────────────────────────┴─────────┐          │
│              ▼ B app                                                          ▼ A app    │
│  growth report.html (private) · coach (opt-in,             consent preview → .aiprof     │
│  own CLI) · history (opt-in) · share card · export         (signed, invite-bound,        │
│                                                             optional seal + timestamp)   │
└───────────────────────────────────────────────────────────────────┬──────────────────────┘
                                                                    │ email / any channel
                        RECRUITER MACHINE (offline)                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ai-profiler verify x.aiprof ─► authenticity · invite · integrity band ─► dossier.html    │
│ ai-profiler compare *.aiprof ─► compare console.html (role-fit bands, notes, CSV)        │
│ ai-profiler verify --brief ─► recruiter's own LLM drafts prep notes (opt-in)             │
│ interview: kit probes · walkthrough of a fingerprinted session · pairing recorder        │
│ ai-profiler calibrate ─► rubric/outcome log → role-profile weight suggestions            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Core engine (lives in B: `core/`)

### 6.1 Source plugins

```ts
interface SourcePlugin {
  tool: ToolId;                 // "claude-code", "codex", …
  id: string;                   // "codex.threadsDb", "claude-code.transcripts", …
  tier: "P0" | "P1" | "P2";     // P2 = beta until verified on real data
  locate(env: Env): Candidate[];               // per-OS paths + env overrides + WSL roots
  fingerprint(c: Candidate): FormatInfo;       // versions, record-type histogram, retention, unknown types
  scan(c: Candidate, ctx: ScanCtx): AsyncIterable<Ev>;
}
type Ev =
  | { k: "session"; id; parentId?; tool; origin: "human"|"scripted"|"subagent"|"scheduled"|"peer";
      start; end; model?; projectKey; spawnDepth?; agentType?; background? }
  | { k: "prompt"; ts; sessionId; origin; intent; features: PromptFeatures }  // features = counts/flags only
  | { k: "tool"; ts; sessionId; name; category; ok?: boolean; ms?: number; exit?: number }
  | { k: "usage"; ts; sessionId; model; in; out; cacheR; cacheW; usd? }
  | { k: "edit"; ts; sessionId; ext; added?; removed? }
  | { k: "config"; kind; name?; provenance: "authored"|"installed"|"unknown"; uses: number; firstSeen? }
  | { k: "marker"; ts; sessionId; kind: "interrupt"|"compact"|"clear"|"plan"|"queue"|"pr"|"commit"|"denial"|… }
  | { k: "coverage"; source; from; to; retention; files; bytes; skipped; unknownTypes: Record<string,number> };
```

Rules every plugin follows:
- **Streaming:** `Bun.file().stream()` → line splitter → sniff the `type`/`kind` prefix → skip known heavy record types (`api-request-blob`, `api-request`, `file-history-*`, tool-result payloads) **before** `JSON.parse`; per-line cap ~32 MB; never whole-file caps.
- **SQLite:** open in place with `file:…?mode=ro`. If locked/busy, copy `db`+`-wal`+`-shm` into a private `0700` temp dir and delete it in `finally` (also on SIGINT). Never `SELECT *`; query by key prefix with `json_extract`; row caps. Never copy multi-GB databases (Cursor's can reach 30–97 GB).
- **Two read classes (my call).**
  - *Never opened:* credential-only files and stores — `auth.json`, `*.key`, Copilot `apps.json`/`hosts.json`, credential/account tables, OS keychains.
  - *Mixed files* (e.g. `~/.claude.json`, `history.jsonl`, `state.vscdb`, Codex `threads`): parsed in memory with the standard parser, but only **allowlisted fields** are extracted into program state; everything else is dropped with the parse tree — including `oauthAccount.emailAddress`, MCP `env` blocks, `pastedContents.content`, `oauthToken`, `ai-title` records, and subagent meta `description`. SQL never selects Codex `first_user_message`/`title`/`preview`. The single identity field extracted is `oauthAccount.accountUuid` (for C4), held only as HMAC(per-run salt, uuid). The privacy statement says exactly this — that mixed files are parsed, and what is kept.
- **Repo signals (allowlisted, in memory; my call).** Only for repos discovered from session `cwd`s, never by crawling: `git log` metadata (timestamps, trailers, file-path hashes, revert/fix-up markers); instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`) scanned in memory for test/build/lint command mentions → booleans and counts; `.claude/settings.json` hooks → event + command category; `.github/workflows/*.yml`, `.pre-commit-config.yaml`, `lefthook.yml`, `.husky/` → exists + invokes checks (boolean). Source files are never read. `--explain` lists all of it; A's consent step and B's `--no-repo-signals` switch it off (Verification guardrails and Delivery then show "not measured").
- **Origin is first-class:** only `origin:"human"` prompts feed prompt-level signals; scripted/subagent work feeds leverage/orchestration.
- **Drift:** unknown record types and zero-yield sources produce `coverage.unknownTypes` and a "format changed?" warning — never silent zeros.
- **Dedupe across tools:** Codex `originator:"Claude Code"`, VS Code agent-host sessions, Claude Desktop `cliSessionId`, Cursor IDE vs cursor-agent, Copilot `.json` + `.jsonl` copies of one session.
- **Project identity:** from record `cwd`, never by splitting slugs; exported only as salted hashes.

**Per-tool requirements** (full field lists in `core/sources/<tool>/FORMAT.md`, seeded from the brainstorm notes):

| Tool | Must read | Key fixes vs v1 |
|---|---|---|
| **Claude Code** (P0) | `projects/<slug>/*.jsonl`, `<sid>/subagents/agent-*.jsonl` + `.meta.json`, `<sid>/subagents/workflows/wf_*/`, `<sid>/workflows/*.json`, `history.jsonl`, `stats-cache.json`, `~/.claude.json` (`skillUsage`, `pluginUsage`, `promptQueueUseCount`, `lastPlanModeUse`, `firstStartTime`), `plugins/installed_plugins.json`, `projects/*/memory/*.md` (count only), CLAUDE.md/AGENTS.md at session cwds (existence + git history only); `$CLAUDE_CONFIG_DIR` | recurse subagents/workflows (54% of tool calls [measured]); human = `promptSource ∈ {typed, queued, suggestion_accepted}` or `turnOrigin = human`, excluding `isMeta`, `turnOrigin ∈ {task_notification, peer, scheduled, sdk, auto_continuation}`, `entrypoint = sdk-cli`; heuristic fallback only when fields are absent; read `cost-state`, `system:turn_duration`, `system:compact_boundary`, `permission-mode`, `toolDenialKind`, `effort`, `pr-link`, `queue-operation`, tools `TaskCreate/Workflow/Monitor/CronCreate/ExitPlanMode`; attribute subagent actions to the parent turn via `tool_use.id` → `.meta.json` `toolUseId` |
| **Codex** (P0) | `sessions/**/rollout-*.jsonl`, `archived_sessions/`, `state_5.sqlite` (`threads`, `thread_spawn_edges`), `thread_history_1.sqlite` (`thread_turns`), `history.jsonl` (human prompts), `config.toml`, `skills/`, `plugins/`, `memories/`; `$CODEX_HOME` | shell calls are `custom_tool_call name:"exec"` (free-form string input) and `exec_command {cmd}` — use `item_completed`→`CommandExecution` (command, exit_code, duration); split by `session_meta.payload.source` (`exec`/`subagent`/`cli`/`vscode`); drop injected tag messages (`<recommended_plugins`, `<image`, `<codex_internal_context`, `<turn_aborted`, `# AGENTS.md`, `<skill>`); thread index is the durable lifetime layer (51% of threads have no rollout left [measured]); multi-agent calls `spawn_agent/send_message/wait_agent/followup_task/interrupt_agent`, `update_plan` |
| **Copilot** (P0) | VS Code `workspaceStorage/*/chatSessions/*.jsonl` (journal) + legacy `.json`, `globalStorage/emptyWindowChatSessions/`, `globalStorage/github.copilot-chat/session-store.db`; Copilot CLI `~/.copilot/session-state/*/events.jsonl`, `~/.copilot/session-store.db`; JetBrains `github-copilot/<ide>/chat-*-sessions/*nitrite.db` (beta) | replay the journal (`kind:0` snapshot, `kind:1` set at path, `kind:2` append); dedupe by sessionId (v1 is blind after 2026-02-23 [measured]); `agent.id = editsAgent` is agent mode (202/219 requests here are agentic, v1 called them chat); install detection must include VS Code's bundled Copilot |
| **Cursor** (P0, not installed here → fixtures from docs) | `globalStorage/state.vscdb` table `cursorDiskKV` (`composerData:*`, `bubbleId:*:*`), legacy `ItemTable` keys as fallback, `~/.cursor/ai-tracking/ai-code-tracking.db` (`scored_commits`: AI vs human committed lines), `~/.cursor/projects/*/agent-transcripts/`, `~/.cursor/chats/*/*/store.db` | query in place, prefix-filtered; tool decisions (`toolFormerData.userDecision`), `thinkingDurationMs`, `errorDetails`, PRs |
| **Antigravity** (P0) | CLI `~/.gemini/antigravity-cli/{conversation_summaries.db, conversations/*.db (steps), brain/<id>/.system_generated/logs/transcript.jsonl, history.jsonl}`; IDE `antigravityUnifiedStateSync.trajectorySummaries` (base64 protobuf) in both `Antigravity` and `Antigravity IDE` app dirs; older `~/.gemini/antigravity/brain/<id>/{task,implementation_plan,walkthrough}.md` (existence/count only) | replace notification-key counting (20 UUIDs vs 12 real trajectories [measured]); never read `oauthToken` or the auth email; protobuf-lite decoder for summaries |
| **Gemini CLI** (P1) | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (`{kind}` header + `$set` lines; `.json` ≤ v0.38), `logs.json`, `projects.json` | new |
| **OpenCode** (P1) | `~/.local/share/opencode/opencode.db` (older `storage/` JSON), `~/.local/state/opencode/prompt-history.jsonl` | new; sessions with `parent_id` → delegation |
| **Cline / Roo / Kilo** (P1, one parser) | VS Code `globalStorage/{saoudrizwan.claude-dev, rooveterinaryinc.roo-cline, kilocode.kilo-code}/tasks/<id>/{ui_messages, api_conversation_history, task_metadata}.json`, `~/.cline/data/tasks/` | new |
| **P2 beta** | Windsurf → Devin Desktop (`~/.codeium/windsurf/`, Devin CLI `sessions.db`), Zed `threads.db` (zstd JSON), Kiro, Warp `warp.sqlite`, Amp threads, Goose `sessions.db`, Factory Droid sessions, Qwen Code chats, Crush `crush.db`, Aider `.aider.chat.history.md`/`.aider.input.history`, Continue sessions, JetBrains AI/Junie XML | parsers from public docs + synthetic fixtures; coverage marks them `beta`; zstd/protobuf decoding only where a small pure-TS decoder exists, else report "present, not decodable" |
| **Git corroboration** | repos discovered from session cwds only (no disk crawl): commit metadata + trailers (`Co-Authored-By`, "Generated with"), timestamps, file paths touched (hashed), reverts/fix-ups | AI-co-authored share, commit-after-session, rework within 72 h; PR URLs/SHAs are externally checkable anchors |
| **Windows + WSL** | `\\wsl.localhost\<distro>\home\*\{.claude,.codex,.gemini,…}` | new |

### 6.2 Two time layers and coverage

```
  lifetime index layer  ─────────────────────────────────────────────►  history.jsonl, stats-cache.json,
  (months; counts, dates, models, sessions)                               Codex threads DB, Copilot journal…
  detail layer                                    ├──── ~30 days ────┤   pruned transcripts/rollouts
  (tool calls, outcomes, edits, subagents)
```
- Every metric carries `{source, window: "detail"|"lifetime", from, to, n}`; numerator and denominator always come from the same store and window.
- The report header prints coverage per tool; recent-vs-lifetime are shown side by side, never blended.
- Days count as active only with ≥ 1 human prompt (zero-count days and file mtimes never count).

### 6.3 In-memory text features (no text leaves the plugin)

- **Origin** (above) and **intent** — deterministic rules + lexicons labelling each human turn: `spec`, `question`, `ack`, `correction`, `redirect`, `command`, `continuation`. Slash/`!` commands are `command`, not "bare prompts".
- **Structure features** of task-start briefs only: has-context (code/error/paste), file refs, list structure, constraint language, length bucket.
- **Technical categories**: term matches are collapsed to category counts (data, infra, security, testing, AI/ML, architecture, frontend) — the term list is shown in the preview.
- Re-ask detection via in-memory shingle similarity between consecutive human turns (only the similarity score survives).

### 6.4 Signals catalogue

| Signal | Computation | Source(s) |
|---|---|---|
| Verify-after-edit (VAE) | share of edit turns where a test/build/lint/typecheck command runs after the last edit, gated on exit codes and language match | CC Edit/Write → Bash + `is_error`; Codex fileChange → CommandExecution `exit_code`; Cursor/Antigravity steps |
| Red→green closure | share of failing checks that later pass within the episode; median fix cycles | same |
| Autonomy that sticks | actions per human turn incl. attributed subagent/child-thread work, counted only if not interrupted/corrected within 10 min and not ending on ≥ 2 errors | CC + subagents, Codex + spawn edges, OpenCode parent_id |
| Parallelism | share of active 10-min buckets with ≥ 2 sessions doing agent work; peak concurrency; background share | lifetime timestamps × sessionId; subagent `requestShape`/background |
| Delegation shape | fan-out per episode, subagent types (explore/implement/review/plan), workflow use, depth | CC meta/workflows, Codex spawn edges |
| Steering quality | interrupts classified as healthy (early + substantive redirect) vs thrash (followed by churn/re-ask); queue use | markers + intent labels |
| Context engineering | instruction files maintained in active repos (git history), memory files, artifacts weighted authored 1.0 / installed 0.3 / unused 0 by actual invocations | `skillUsage`, skill-lock provenance, plugin usage, MCP calls, hooks firing |
| Judgment (right-sizing) | deliberate model/effort switches per active week; Spearman ρ between tier chosen and task size | `/model`, `/effort`, subagent model overrides, Codex per-thread effort |
| Efficiency | cost or tokens per landed unit (commit/PR/lines kept) | `cost-state`, `tokens_used`, `stats-cache.modelUsage` |
| Context hygiene | manual vs auto compaction, `/clear` at task boundaries | `compact_boundary.trigger`, commands |
| Delivery & rework | share of edit episodes followed by commit/PR within 24 h; reverts/fix-ups on the same files within 72 h; PRs per active week | `pr-link`, `toolUseResult.gitOperation`, git |
| Risk posture (shown, not scored) | permission/approval/sandbox modes in use | CC permission-mode, Codex approval/sandbox |
| Exposure (shown, not scored) | tenure, active weeks, volume per tool, session arcs, tools in rotation, first-seen dates of features | lifetime layer |

### 6.5 Scoring model

**Units.** Typed turn *t* (human origin); episode *e* = first human prompt of a session / after `/clear` / after a ≥ 30-min gap; `A_t` = actions attributable to *t* (main + subagents + child threads); `s_t = 1` unless followed by interrupt/correction within 10 min or the run ends on ≥ 2 errors.

**Transforms.** counts → `log1p`, rates → `logit` (clamped), then `z` against the reference table, then display score `= 100·Φ(z)` (a percentile vs the *reference*, open-tailed — no hard caps).

| Dimension | Formula (z-components) | Min. evidence |
|---|---|---|
| **Leverage** | 0.6 z(mean s_t·log2(1+A_t)) + 0.4 z(log p90 successful run) | 60 turns, 5 sessions, 10 days |
| **Orchestration** | 0.35 z(parallel buckets share) + 0.30 z(finished fan-out / episode) + 0.20 z(headless runs / active week) + 0.15 z(background share) | 14 days, 20 episodes |
| **Verification** | 0.5 z(VAE weighted by log lines changed) + 0.3 z(closure) + 0.2·guardrails (check-running hooks, CI/pre-commit, instructions naming test commands) | 20 edit turns |
| **Steering** | 0.4 z(−correction rate after briefs) + 0.3 z(healthy-interrupt share) + 0.3 z(−human turns per log work) | 30 follow-up turns |
| **Context** | 0.35·(active repos with maintained instruction files) + 0.35 z(used artifacts, provenance-weighted) + 0.15·hygiene + 0.15 z(task-start brief structure) | 20 episodes or 3 repos |
| **Judgment** | 0.4 z(deliberate switches / active week) + 0.4 z(ρ tier vs task size) + 0.2 z(−cost per landed unit) | 30 episodes with known model+effort |
| **Delivery** | 0.5 z(edit episodes → commit/PR ≤ 24 h) + 0.35 z(−rework ≤ 72 h) + 0.15 z(PRs / active week) | 10 edit episodes in git repos |

- **Confidence:** Low / Medium / High = 1× / 3× / 10× the minimum **and** ≥ 1 / 3 / 6 distinct weeks. Below minimum → "insufficient (n=12, needs 50)", excluded from the overall, and turned into an interview probe (A) or a "not enough data yet" note (B).
- **Shrinkage:** shown `z' = z·n/(n+n_min)`; **intervals:** session-level bootstrap (B=200) over per-session sufficient statistics → "71 [63–78]".
- **Field gating:** each component declares the fields it needs per tool version; missing → fallback or "not measurable on this version", never 0.
- **Reference table v0** (`core/scoring/reference/v0.json`, versioned, printed in Method): per component an expert-set p50/p90 on the transformed scale (μ = p50, σ = (p90 − p50)/1.2816) with a written rationale, sanity-checked against synthetic personas (novice → expert) and a local run on this machine (results never committed). v1 = empirical quantiles after ≥ 100 consented aggregate submissions, or per-employer "among your applicants".
- **Overall:** confidence-weighted mean of dimension z over dimensions at ≥ Medium confidence; weights Verification 0.20; Leverage, Orchestration, Steering, Context 0.15 each; Judgment, Delivery 0.10 each; displayed as band + interval + coverage ("6/7 dimensions"). Bands: Exceptional / Strong / Developing / Limited / Insufficient evidence.
- **Unscored panels:** Exposure, Agent-touched stack (languages/toolchains — relabelled, not "knowledge"), Risk posture, Coverage.
- **Personas:** top-3 role names derived from signal mix (no "% match"); B shows them as a playful identity layer, A as "reads as …".
- **Bugs fixed by construction:** machine text as prompts; slash commands as bare prompts; zero-count days; UTC/local streak mix; installs counted as depth; double counting the same evidence across axes; mixing windows in rates; mean-of-ratios and weighted-p75 math; Copilot agent mode counted as chat; invented Antigravity prompts.

### 6.6 Forensics and integrity (core; A shows it as Integrity, B as "Data health")

| Check | Rule | Measured baseline on genuine data |
|---|---|---|
| C1 CC `req_`/`msg_` IDs linear in time (base58 after 4-char prefix) | > 1% of messages off by > 10 min → fail; scheme change → "n/a" | R² 1.000000 over 4,652 IDs; residual p99 63 s |
| C2 ID order vs time order | Spearman < 0.99 → fail | 1.0 over 10,680 |
| C3 history.jsonl vs transcripts vs stats-cache | < 75% match → warn; transcript days missing from stats-cache → fail | 94% match; 184/186 shared days |
| C4 session `accountUuid` vs `~/.claude.json` (compared as keyed hashes) | 0% match → fail; > 1 account → note | 1,227/1,227 |
| C5 file times | mtime < last event or ctime ≫ mtime → fail; ≥ 80% of files born in one 10-min window spanning > 7 days of events → "copied/restored on DATE — ask about it" | clean |
| C6 every Codex rollout has a `threads` row | missing → fail | 1,173/1,173 |
| C7 Codex UUIDv7 time ≤ filename time | later → fail | never later |
| C8 Codex rate-limit ledger monotone within windows | contradictions → fail (spliced traces) | 99.88% non-decreasing |
| C9 tool versions / models vs release dates (dated table shipped per release) | used before release → fail | — |
| C10 provenance fields (`promptSource`, `turnOrigin`, `entrypoint`, `originator`) | classify only | — |
| Soft flags | prompt-rhythm regularity, ≥ 200-char prompts repeated ≥ 5×, activity share in the 14 days before the scan, `tool_use` without `tool_result`, config created < 7 days before scan | — |

Do **not** use (misfire on genuine data [measured]): monotonic timestamps within files, duplicate-prompt share, tokens vs cost ratios.
Output: band **Consistent / Consistent with notes / Inconsistent / Unverifiable**, the share of scored activity backed by server-minted data, and per-check reasons with an "ask about" question. No automatic rejection. **Server-backed share is display-only (my call):** it never changes scores, evidence minimums, or confidence, because tool choice must not become a hiring factor. Tools with no server-minted IDs (Cursor, Copilot, Antigravity, all P2) are labelled "not anchorable" — neutral, not a penalty — and are corroborated in the walkthrough instead. Every check is public — the docs say plainly that forensics raise the cost of cheating; they don't prove honesty.

### 6.7 Privacy layer

- **Allowlisted export schema** (`core/privacy/schema.ts`): every exported field is declared with type and sensitivity class; the exporter walks the schema and drops everything else (deny by default). Evidence prose is generated at render time from sanitized data, never from raw names.
- **Field decisions:** drop hostname, machine user, emails, usernames, Copilot/Antigravity identity; projects → salted opaque labels (`P-3F2A`) + aggregates (candidate may reveal chosen names); MCP servers → names on a public allowlist, others "custom #n"; tool names → built-ins only; daily activity → weekly buckets for 12 months; hours → four coarse day-part bands (B only, private); tech terms → category counts; `agentIds` → count; account bindings → HMAC(invite nonce or per-run salt, id).
- **Preview contract:** both apps can render exactly the bytes that would be exported (raw-JSON toggle). A requires explicit confirmation before sealing.
- **Where real names may appear (my call):** only on surfaces that by design never leave the machine — A's terminal consent UI (a label ↔ name table used to exclude or reveal projects) and B's private report (names shown by default; `--anonymize` hides them). Never in A's `preview.html` or candidate copy (labels only — these files get forwarded by mistake), bundles, share cards, employer exports, or logs. `--explain` prints paths with the home directory collapsed to `~`. The canary harness encodes one rule per surface.
- **Temp files:** none by default; any fallback copies are 0700 and deleted in `finally`/signal handlers. A test asserts the temp dir is clean after every scan.
- **Canary tests:** fixtures plant fake emails, hostnames, paths, secrets, prompt text, and client-like project names; tests assert none appear in exported JSON, the HTML, or logs.
- **Corrected privacy statement** (both READMEs, `--help`, Method section): "reads local history files, which contain your prompts, replies and code, in memory to count things; keeps none of the text; never opens credential files; shares nothing until you approve the preview; offline by default." (Full draft in brainstorm notes `03-trust-privacy.md` §6, adapted per product.)

### 6.8 Shared visual system and viz kit (`core/viz/`)

- **World:** evolve v1's instrument dashboard into an **assay certificate** — ink + gold, the struck seal, data-ink over decoration.
- **Type roles:** mono (JetBrains Mono, tabular) for every measurement; Archivo Expanded for structure (caps only ≥ 18 px); an embedded text serif (Source Serif 4 or Newsreader, OFL, Latin subset, 2–3 styles) for interpretation. Scale 12/14/16/20/28/44/64; min 12 px screen, 7.5 pt print.
- **Colour = meaning:** gold only for the subject's measurements and the seal; vermilion for flags; verdigris for passes; no per-tool colours. Mark grammar: solid = sufficient evidence, hollow = thin, hatched = not measurable locally.
- **Themes:** dark "ink" and light "paper" (paper = print theme), `prefers-color-scheme` + toggle; a build-time test enforces text contrast ≥ 4.5:1, marks ≥ 3:1, monotone heatmap ramps.
- **Motion:** the seal strikes once (≤ 500 ms) only when integrity passes; no count-ups or scroll reveals; hovering a finding highlights the evidence it cites.
- **Primitives (pure SVG strings, no libraries):** assay ledger (dot + interval + ceiling/reference marks + expandable components), swimlanes (relative time), delegation outline (text tree), verification funnel, habit & rotation lanes, then→now table, heatmap with fixed buckets, small multiples. Engine pre-bins: payload ≤ 300 KB, ≤ 600 bins/lane, < 5,000 DOM nodes.
- **Print:** `@page{margin:14mm}`, running footer "Name · No. · p X/Y" (margin boxes, fixed fallback), `break-before:page` per chapter, `print-color-adjust:exact`, `beforeprint` → paper theme + open all `<details>`.
- **Accessibility:** landmarks, `figure/figcaption` one-sentence summaries per chart, nothing hover-only (tap pins), keyboard navigation for any toggles.

### 6.9 Public API

```ts
import { scan, analyze, exportPayload, renderKit } from "ai-practice-report/core";
const raw = await scan({ tools: "all", wsl: true, onProgress });   // events + coverage, in memory
const a   = analyze(raw, { reference: "v0", bootstrap: 200 });     // signals, dims, exposure, forensics
const out = exportPayload(a, { schema: "aiprof/2", reveal: [] });  // allowlisted, sanitized
```
Semver: breaking changes to the export schema bump the major; A pins the core by commit SHA (tag noted for readability).

---

## 7. B — AI Practice Report (app)

### 7.1 CLI

```
ai-practice                     scan → private report.html (opens in browser)
  --explain                     list every path/store that would be read, read nothing, exit
  --json                        also write the sanitized analysis JSON
  --keep-history                opt-in: append this run's aggregates to ~/.ai-practice/history.jsonl
  --coach [claude|codex|gemini] opt-in: own-agent coaching notes (§7.3)
  --share-card                  write share-card.svg/png (minimal, chosen fields only)
  --export-for-employer         write an unsigned aiprof/2 bundle (A shows it as "self-reported")
  --tools a,b  --since DATE  --no-open  --out PATH  --purge (delete history/cache)
```

### 7.2 Report information architecture

```
┌ YOU ─────────────────────────────────────────────────────────────────────┐
│ name (optional) · coverage strip (tools × windows) · "reads as" 3 roles  │
│ Practice profile: 7-dim assay ledger (dot ± interval, components)        │
│ This month vs last (if history) · Then → Now (first 90 vs last 90 days)  │
├ NEXT 3 UPGRADES ─────────────────────────────────────────────────────────┤
│ each: the evidence (→ Ex.) · why it matters · a concrete recipe          │
│ (e.g. "add a hook that runs your tests after edits — 39% unchecked")     │
├ EXHIBITS ────────────────────────────────────────────────────────────────┤
│ A a day under the loupe · B delegation outline · C verification loop     │
│ D habit & rotation · E then→now · F agent-touched stack · day-part bands │
├ COACH NOTES (only with --coach, labelled with model id + input hash) ────┤
├ DATA HEALTH (forensics band, coverage, drift warnings) ──────────────────┤
├ SHARE / EXPORT ──────────────────────────────────────────────────────────┤
└ METHOD (sources, windows, reference v0, formulas, privacy statement) ────┘
```
- Upgrade recipes are rule-based, keyed to the lowest-confidence-adjusted components, each citing its exhibit.
- Tone: personal and encouraging but evidence-first; no trophies.

### 7.3 Coach (opt-in, own agent)

1. Detect installed CLIs (`claude`, `codex`, `gemini`); user picks one.
2. Build a **structural digest**: dimension scores and components, ≤ 10 sampled episodes as tool-sequence/outcome/intent-label skeletons — **no prompt text, code, paths, or names**.
3. Show the digest and require confirmation; it goes to the user's own provider.
4. Call `claude -p --output-format json` / `codex exec --output-schema` / Gemini equivalent with a strict JSON schema `{observations[], upgrades[{title, evidenceRefs[], steps[]}], cautions[]}`; 3 runs, merge by majority; record model id + input hash.
5. Render as clearly labelled "Coach notes"; never feeds scores; never included in employer exports.

### 7.4 History and month-over-month

- Opt-in local store of per-run aggregates (no events, no text). The report shows deltas per dimension with interval overlap ("changed" only when intervals separate).

### 7.5 Share card and employer export

- Share card: SVG (and PNG rendered in-page via canvas) showing name (optional), top-3 roles, the 7-dim ledger without raw counts, date; user picks fields.
- Employer export: an unsigned `aiprof/2` bundle; A's `verify` renders it with a "self-reported — not verified" banner and no integrity band.

---

## 8. A — AI Candidate Profiler v2 (app)

### 8.1 The hiring loop

```
 RECRUITER                                             CANDIDATE
 ai-profiler keys init  (company Ed25519 + X25519)
 ai-profiler invite --role backend --name "J. Doe" --expires 14d
   └─► token: aiprof-inv1.<b64 JSON{v,id,company,role,roleHash,nonce,iat,exp,fields,sealTo}>.<sig>
                     ───────── invite (email/ATS) ─────────►
                                                       verify the download (SHA256SUMS + gh attestation)
                                                       ai-profiler --explain          (optional dry run)
                                                       ai-profiler --invite <token>
                                                         1 read-only scan (core)
                                                         2 sanitize (allowlist) + forensics
                                                         3 consent: preview.html + terminal exclusions
                                                         4 JCS → Ed25519 (release key) [+seal][+TSA]
                                                         5 writes jdoe.aiprof + candidate-copy.html
                     ◄──────── jdoe.aiprof (any channel) ─────────
 ai-profiler verify jdoe.aiprof [--brief]
   banner: Signed v2.0.0 · invite A1B2 · TSA 17 Nov 10:42 · Consistent with notes (1) · 86% server-backed
   └─► dossier.html rendered from A's own template (never the candidate's HTML)
 ai-profiler compare *.aiprof  ─► console.html
 interview (45'): 10' walkthrough of a fingerprinted session · 15' kit probes · 20' pairing
   candidate: ai-profiler session start/end ─► pairing.aiprof (Exhibit P)
 ai-profiler calibrate  ─► rubric + outcome log → role-profile weight suggestions
```

### 8.2 Keys, invites, bundles

- **Release key:** one Ed25519 keypair per major release line, private key held only in the protected GitHub Actions `release` environment (owner approval per run), injected at compile time (`--define`) so it is never in the repo; public keys + key IDs + revocation list ship in `src/trust/release-keys.json`. Local/dev builds use a dev key and verify as "dev build". Honest framing everywhere: proves "produced by an official vN binary or by someone who extracted its key".
- **Company keys:** `keys init` writes `~/.ai-profiler/company.json` (0600): Ed25519 (invites) + X25519 (sealing); prints a public fingerprint.
- **Invite token:** compact, signed by the company key; carries role id + role-profile hash + requested fields + expiry + nonce + `sealTo`.
- **Bundle `aiprof/2`:**
  ```json
  { "format": "aiprof/2",
    "meta": {"profiler": "2.0.0", "core": "1.0.0", "createdAt": "…", "keyId": "rel-2026a"},
    "invite": "aiprof-inv1….",
    "payload": { "…": "allowlisted analysis" },
    "integrity": { "band": "consistent-with-notes", "serverBacked": 0.86, "checks": [] },
    "fingerprints": [{ "fp": "hmac…", "day": "2026-11-02", "tool": "claude-code", "size": "L" }],
    "exclusions": { "tools": 0, "projects": 2, "sessions": 14 },
    "timestamp": { "tsa": "…", "token": "b64", "genTime": "…" },
    "signature": { "alg": "Ed25519", "keyId": "rel-2026a", "sig": "b64" },
    "sealed": null }
  ```
  Signature over RFC 8785 (JCS) canonical JSON of everything except `signature`/`timestamp`. Sealing (when the invite has `sealTo`): X25519 ECDH → HKDF-SHA256 → AES-256-GCM over the canonical payload; only `format/meta/invite` stay in the clear.
- **Timestamp (opt-in network):** RFC 3161 request over the payload hash to a public TSA; stores the token; `verify` checks the CMS signature and that `genTime ≤ invite.exp`. Off by default; the candidate is told exactly what is sent (a hash + nonce).

### 8.3 Candidate consent flow

```
scan ─► preview.html opens (every field to be shared, raw JSON toggle, what was read vs shared)
     ─► terminal: [1] exclude tools  [2] exclude projects  [3] exclude date range  [4] reveal a project name
                  [5] toggle timestamp (network)  [c] confirm and seal  [q] quit (nothing written)
     ─► exclusions recorded as counts in the bundle
non-interactive: --yes --exclude-tool X --exclude-project P-3F2A --since 2026-06-01 --timestamp
```

### 8.4 Verify and the dossier ("assay certificate")

Reading order: 10-second certificate → 2-minute skim → exhibits → interview kit → method & chain of custody. One long document, sticky contents rail (desktop) / chapter bar (mobile), fixed chapter order so dossiers compare side by side, every claim cites a lettered exhibit, every exhibit shows its window + n.

```
AI LEVERAGE ASSAY · No. 7F3A-91C2 · 17 Nov 2026 · v2.0.0                     ◐ theme  ⎙ PDF
──────────────────────────────────────────────────────────────────────────────────────────
JORDAN EXAMPLE                                                         ╭────────────────╮
reads as  Backend · Orchestrator · QA          role: Backend (invite)  │       90       │
                                                                       │    (86–93)     │
"Runs agents as infrastructure: fans work out to subagents, checks it  │  EXCEPTIONAL   │
 with tests, and has kept that up most weeks for eight months."        │   ● struck     │
                                                                       ╰────────────────╯
EVIDENCE   detail  62 sessions · 940 human turns · 210 subagent runs
           life    8 months · 6 tools (3 active) · 34 active weeks
INTEGRITY  ● Consistent · 7/7 checks · 86% server-backed                          → §6
ROLE FIT   must-haves: Verification ● meets · Delivery ● meets · Steering ◐ partial
──────────────────────────────────────────────────────────────────────────────────────────
                       0        25        50        75       100   score     conf  window
WORKING WITH AGENTS
  Leverage            ├────────┼────────┼────────┼────[──◆─]┤      91 [86–95] ●●●  detail
  Orchestration       ├────────┼────────┼────────┼──────[─◆▲      97 [93–99] ●●●  detail
  Steering            ├────────┼────────┼───┆[───◆──]──────┤      72 [63–80] ●●○  detail
QUALITY
  Verification        ├────────┼────────┼──────[──◆──]─────┤      66 [58–74] ●●●  detail
  Delivery            ├────────┼────────┼────────┼─[──◆─]──┤      83 [76–89] ●●○  detail
SETUP & JUDGMENT
  Context             ├────────┼────────┼────────[──◆──]───┤      74 [65–82] ●●○  both
  Judgment            —  insufficient (n=12 episodes with known effort, needs 30)  → Kit 2
  ◆ score  [ ] interval  ▲ open tail  ┆ reference  ●●● confidence
──────────────────────────────────────────────────────────────────────────────────────────
WHY    ① Delegates: 1 in 5 tasks fans out to subagents                        → Ex.B
       ② Verifies: 61% of edit bursts checked by test/build                   → Ex.C
       ③ Habit: active 6 of 7 days a week over the last 90                     → Ex.D
WATCH  ⚑ 39% of edit bursts unchecked; 4% end still failing                    → Ex.C
ASK    "Show me how you decide an agent's change is done."                     → Kit 1
```
- Seal states: **struck gold** (sufficient evidence and no failed check — "not anchorable" tools are neutral and appear as an integrity line, not a seal state) · **outlined PROVISIONAL** (thin evidence) · **vermilion FLAGGED** (an integrity check failed; banner above everything).
- No hire/advance recommendation — "what to verify next" instead.
- Chapters: §0 Certificate · §1 How they work (ledger expanded, Ex.A day under the loupe, Ex.B delegation outline, Ex.C verification loop) · §2 Habit & trajectory (Ex.D habit & rotation, Ex.E then→now) · §3 Range (Ex.F agent-touched stack, tool ledger table) · §4 Findings (Strengths · Watch · **Unknowns**) · §5 Interview kit · §6 Method & chain of custody (sources, windows, caps, integrity checks with ⚑ propagated to affected exhibits, redactions/exclusions, weights, scorer + reference versions, payload hash, release key ID, CSP).
- `verify --brief` (opt-in): the **recruiter's** own `claude -p`/`codex exec` drafts prep notes and extra probes from the verified, sanitized payload; labelled as AI-drafted; never alters scores.

### 8.5 Interview kit and pairing-session recorder

- Probes generated from gaps and unknowns, ordered by uncertainty × dimension weight; each probe card prints with write-in lines:
```
PROBE 3 · VERIFICATION                      targets  Verification ●●● · Delivery ●●○
Because  39% of edit bursts unchecked; 4% ended with a failing check            → Ex.C
Ask      "Show me how you decide an agent's change is done."
Listen   names concrete gates (tests, typecheck, diff review) and a time one caught
         a confident-but-wrong agent
Flags    "the model's usually right"; can't recall a single failure
Follow   "What did you change in your setup afterwards?"
Score    ☐ 1   ☐ 2   ☐ 3   ☐ 4     notes ________________________________________
```
- **Walkthrough:** the bundle lists ~8 fingerprinted sessions (diverse by tool, size, recency, incl. the peak-parallel one); the candidate runs `ai-profiler find <fp>` to locate it locally and walks through it on screen share.
- **Pairing recorder:** `ai-profiler session start --invite <token>` snapshots source cursors; `session end` analyses only new events → `pairing.aiprof` (signed) → Exhibit P: agents run, delegation, verification loop during the live exercise. Pairing exercise packs are stretch (P6).

### 8.6 Role profiles, compare console, calibration

- **Role profiles** (`roles/*.json`, shipped: backend, frontend, full-stack, platform/infra, AI engineer, tech lead; editable): `mustHaves[{dimension, targetBand, weight, why}]`, `niceToHaves`, `probeBank`. The invite carries the role id + content hash. Role fit is shown per must-have as **meets / partial / below / insufficient** using interval vs target — no total.
- **Compare console** (`compare` → one offline HTML): verified bundles side by side on the role's must-haves and all dimensions (intervals overlaid), integrity bands, notes per candidate, shortlist toggle, CSV export. Default order = import order; the recruiter sorts explicitly by any column.
- **Calibration log:** `~/.ai-profiler/calibration.jsonl` (rubric scores per probe, decision, optional later outcome); `calibrate` reports per-dimension relationships with n and caveats, and suggests role-profile weight changes only when n ≥ 20.

### 8.7 v1 compatibility

`--name`, `--out`, `--json`, `--no-open` keep working; `--redact` is now the default (accepted, prints a notice); `--reveal-projects` added. `verify` on a v1 HTML says "v1 report — unverifiable".

---

## 9. Repository layouts

```
ai-practice-report/ (B)                         ai-candidate-profiler/ (A)
├─ package.json  exports ./core ./viz           ├─ package.json  dep: ai-practice-report@<tag>
├─ core/                                        ├─ src/
│  ├─ index.ts        scan/analyze/export       │  ├─ cli.ts        candidate + recruiter cmds
│  ├─ env/            paths, overrides, WSL     │  ├─ trust/        jcs, keys, invite, bundle,
│  ├─ io/             jsonl, sqlite, pb-lite    │  │                seal, tsa, release-keys.json
│  ├─ model/          events, aggregate store   │  ├─ consent/      preview, exclusions, prompts
│  ├─ sources/<tool>/ plugin + FORMAT.md        │  ├─ roles/        role-fit
│  ├─ text/           origin, intent, structure │  ├─ dossier/      template + render
│  ├─ git/            trailers, rework          │  ├─ kit/          probe bank + generator
│  ├─ signals/                                  │  ├─ session/      pairing recorder
│  ├─ scoring/        dims, CI, reference/v0    │  ├─ console/      compare template + render
│  ├─ forensics/      C1–C10, soft flags        │  └─ calibrate/
│  ├─ privacy/        schema, hashing, buckets  ├─ roles/*.json  probes/*.json
│  └─ viz/            tokens, fonts, SVG kit    ├─ test/  (fixtures via core's generators)
├─ app/                                         ├─ docs/superpowers/{specs,plans}/
│  ├─ cli.ts  report/  coach/  history/         └─ .github/workflows/ ci, release(+key), guard
├─ test/fixtures/<tool>/<version>/  (synthetic)
├─ scripts/  build.ts  fixtures-gen.ts
└─ .github/workflows/  ci.yml release.yml security-guard.yml
```

---

## 10. Engineering practices

- **Tests (bun test):** synthetic fixtures per tool *and* format version (generated by scripts, committed); golden analysis snapshots; persona fixtures (novice → expert) asserting ordering and no saturation; canary privacy tests; forensic tamper suites (edited timestamps, copied dirs, spliced ledgers, LLM-style fabricated JSONL) that must flag; bundle sign/verify/seal/tamper round-trips; report render tests (DOM budget, no external URLs, CSP present); contrast-token tests.
- **Real-machine smoke (local only, never committed):** run both apps on this Mac; compare against brainstorm measurements (e.g., subagent share, Copilot journal coverage, Codex exec parsing) and record pass/fail in the PR description without data values that identify the owner.
- **Visual QA:** Playwright screenshots of both reports in dark/light, 1440 px and 390 px, and print-to-PDF; reviewed before declaring done.
- **Performance budgets:** this machine full scan ≤ 60 s cold; peak RSS ≤ 1 GB; payload ≤ 300 KB; report < 5,000 DOM nodes.
- **CI:** test matrix on ubuntu/macos/windows for both repos (B is public, so free); release on a protected `v*` tag → job in the `release` environment (owner approval) → 5 targets → `SHA256SUMS` → `actions/attest-build-provenance` → GitHub release; only A's release job sees the release signing key. Third-party actions pinned by SHA. An inline `security-guard.yml` (fake-font + loader-marker gate) as used in the owner's other repos.
- **Versioning:** B `v1.0.0` (core API + app), A `v2.0.0` pinned to B's core by commit SHA.

---

## 11. Build phases

```
P0 Foundations ──► P1 P0 sources ──► P2 Analysis ──┬──► P3 B app ──────┐
 (B scaffold,       (CC, Codex,        (text, git,   │                   ├──► P5 Polish & ship ──► P6 stretch
  IO, events,        Copilot, Cursor,   signals,     └──► P3' A app ─────┤     (visual QA, perf,      (learned intent,
  fixtures,          Antigravity)       scoring,          (trust, consent,│      docs, CI, PRs,         drop-box,
  canary harness)                       forensics,        dossier, kit,   │      releases)              exercise packs,
                                        privacy)          console, roles) │                             notarization)
                           P4 Advanced (parallel after P2): P1+P2 tools · WSL · pairing recorder ·
                              RFC 3161 · verify --brief · coach · history · calibration
```
**One release (owner):** nothing is published until P0–P5 are complete, P4 included; B v1.0.0 and A v2.0.0 launch together. P6 stretch items come after launch.

Acceptance per phase:
- **P0:** B's public repo exists, builds and tests on 3 OSes in CI; streaming reader handles a synthetic 600 MB file in bounded memory; canary harness fails on a planted leak.
- **P1:** each P0 source passes its fixture suite; on this Mac, Claude Code subagent/workflow files are read (≈ 270+ files), Copilot `.jsonl` sessions after 2026-02-23 appear, Codex exec commands are classified, Antigravity counts trajectories from summaries; no temp files remain.
- **P2:** the 7 dimensions + exposure + forensics run on fixtures and on this Mac; this Mac is not saturated (no dimension pinned at 100 without an open-tail mark); every metric carries window + n; canary tests pass.
- **P3 (B):** report renders offline in both themes, prints to a clean PDF, passes the DOM/payload budgets, and shows upgrades with exhibit citations.
- **P3' (A):** invite → candidate run → consent → `.aiprof` → verify → dossier works end to end; tampering with any byte fails verification; sealed bundles open only with the company key; compare console renders 5 bundles.
- **P4:** each added tool passes fixtures and is labelled beta where unverified; pairing recorder produces Exhibit P; TSA round-trip verified against a public TSA (manual, opt-in); coach runs with the local `claude` CLI on a digest containing no text.
- **P5:** both READMEs + privacy statements + methodology accurate; visual QA screenshots reviewed; CI release dry-run on a test tag; B pushed to the new public repo; A PR merged; releases published.

---

## 12. Decided by the owner

- Build **both** products, each "very advanced".
- **Separate repos.** B = new public `build-with-bala/ai-practice-report`, which **hosts the shared core**; A = existing public `build-with-bala/ai-candidate-profiler`, which imports a pinned core.
- **GitHub tokens are rotated** → releases build and sign in GitHub CI (protected environment + approval, tag ruleset, attestations).
- **Everything in one release** — P4 included; no early partial release.
- **B is public from day one.**

## 13. My calls (please check)

1. Offline-only by default in both; the only network feature is A's opt-in RFC 3161 timestamp (hash + nonce only). B's coach talks only through the user's own installed CLI.
2. No hosted service this round (drop-box is P6).
3. An overall is kept as band + interval + coverage; no hire recommendation; compare console has no default ranking.
4. Habit, breadth and languages become unscored panels; late-night/hour signals are removed from A entirely (B shows coarse day-parts privately).
5. Personas survive as top-3 role names only (no "% match").
6. Reference v0 = expert-set anchors validated on synthetic personas; no population percentiles until consented data exists.
7. Release signing key embedded in binaries via CI secret, described honestly as tamper-evidence; provenance via GitHub attestations; notarization later.
8. P2 tools ship as beta parsers built from public docs.
9. Recruiter-side `--brief` (own LLM) allowed in A; candidate-side coach only in B, never scored.
10. B lives locally at `~/Desktop/Personal/2.Code.nosync/ai-practice-report`; A stays at `~/Desktop/neosophical.nosync/tools/ai-candidate-profiler`.
11. Versions: B v1.0.0, A v2.0.0.
12. Builders may inspect the *structure* (never values) of this Mac's real traces to learn formats (§3).
13. Two read classes: credential files are never opened; mixed files are parsed in memory and only allowlisted fields are kept; the privacy statement says so (§6.1).
14. Repo signals are read from an explicit allowlist of files in repos the sessions ran in, never source files, and can be switched off (§6.1).
15. Server-backed evidence share is shown, never weighted into scores; tools without server IDs are "not anchorable", neutral, and can still earn the gold seal (§6.6, §8.4).
16. Real project names appear only in A's terminal consent table and B's private report; everywhere else, opaque labels (§6.7).
17. A pins B's core by commit SHA, not by tag (§3).

## 14. Left to the builder

Exact constants and anchors (within the formulas above), lexicons for intent/categories, module boundaries inside the outlined folders, fixture contents, chart micro-design inside §6.8's rules, CLI flag spellings beyond those listed, error-message wording, internal caching strategy (in-memory per run; any disk cache must be opt-in and purgeable), and how P2 decoders are implemented (pure TS, no native deps).

## 15. Open questions for the owner

None open. The builder check (2026-11-17) raised seven; the owner answered three (GitHub tokens rotated → CI signing; everything in one release; B public from day one) and the rest are settled as my calls 12–17 in §13.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Tool formats change monthly | drift warnings, field gating, per-version fixtures, open-source contributions to B |
| Scale of the build (~20 sources, 2 apps) | phased plan; each phase shippable; parallel A/B after P2 |
| Forensics depend on undocumented ID schemes | "n/a" fallback, never a fail on scheme change; versioned checks |
| Untestable locally (Cursor, Windows, WSL, P2) | fixtures from docs, CI matrix, beta labels |
| Legal (AEDT / EU AI Act) | evidence + human rubric, no ranking, no recommendation, documented method |
| Candidates distrust running a binary | open-source core, `--explain`, attestations, SHA256SUMS, canonical URL, consent preview |
| Reference anchors feel arbitrary | published rationale, versioning, intervals, "vs reference v0" labelling |
