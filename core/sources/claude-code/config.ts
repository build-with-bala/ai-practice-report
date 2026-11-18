import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../env/env";
import { readJsonSmallResult, safeStat } from "../../io/fs";
import { toEpochMs } from "../../io/time";
import type { ConfigEv, IdentityEv, MarkerEv } from "../../model/events";
import { classifyCommand } from "../../text/commands";
import { listDir, readSidecar, Tally } from "../common/coverage";
import { isObj, num, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";

export const CONFIG_SOURCE = "claude-code.config";
const TOOL = "claude-code";
/** Older CLIs keep per-project data in the global config, so it may be large. */
const GLOBAL_CONFIG_MAX = 64 * 1024 * 1024;
/** Hook event names as the CLI spells them (`PreToolUse`, `Stop`, …); any other key is reported as `other`. */
const HOOK_EVENT = /^[A-Z][A-Za-z]{2,40}$/;

type Out = (ev: ConfigEv | MarkerEv | IdentityEv) => void;
interface Usage { uses: number; lastUsed?: number }
/** The allowlisted usage tables of the global config. */
interface GlobalUsage { skills: Map<string, Usage>; plugins: Map<string, number>; mcpServers: Set<string>; firstStart?: number }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile(); // follows symlinks: installers link skill folders into place
  } catch {
    return false;
  }
};
const realpathOf = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
/** Config files are often symlinked from a dotfiles folder: read the link's target, whose own type and size are then checked. */
const resolved = (p: string): string => realpathOf(p) ?? p;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function cfg(kind: ConfigEv["kind"], provenance: ConfigEv["provenance"], name?: string): ConfigEv {
  const ev: ConfigEv = { k: "config", tool: TOOL, source: CONFIG_SOURCE, kind, provenance };
  if (name !== undefined) ev.name = name;
  return ev;
}

/** An allowlisted field when it has the expected JSON type; present with another type → drift `<label>:type`. */
function field<T>(v: Obj, name: string, is: (x: unknown) => x is T, tally: Tally, label = name): T | undefined {
  const x = v[name];
  if (x === undefined || x === null) return undefined;
  if (is(x)) return x;
  tally.unknownKey(`${label}:type`);
  return undefined;
}

/** `$CLAUDE_CONFIG_DIR/.claude.json` when that variable chose this root, else `<home>/.claude.json`, as the CLI resolves it. */
function globalConfigPath(c: Candidate, env: Env): string {
  return c.home === env.home && env.vars.CLAUDE_CONFIG_DIR ? path.join(c.root, ".claude.json") : path.join(c.home, ".claude.json");
}

/** `{<name>: {usageCount, …}}` tables; entries without a usable count are drift (`<label>:shape`). */
function usageTable(table: Obj | undefined, label: string, tally: Tally, ctx: ScanCtx): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const [name, u] of Object.entries(table ?? {})) {
    const uses = isObj(u) ? num(u.usageCount) : undefined;
    if (!isObj(u) || uses === undefined || uses < 0) {
      tally.unknownKey(`${label}:shape`);
      continue;
    }
    if (name !== "") out.set(name, { uses, lastUsed: toEpochMs(u.lastUsedAt, ctx.now) });
  }
  return out;
}

/**
 * The global config is a mixed file (account, MCP definitions with secrets, project paths): it is parsed in memory and
 * only these fields are read — oauthAccount.accountUuid, promptQueueUseCount, lastPlanModeUse, firstStartTime,
 * skillUsage, pluginUsage, and MCP server names (the keys of `mcpServers`, globally and per project).
 */
function readGlobalConfig(file: string, ctx: ScanCtx, tally: Tally, out: Out): GlobalUsage | undefined {
  const r = readJsonSmallResult(file, GLOBAL_CONFIG_MAX);
  if (!r.ok) {
    if (r.reason === "too-large") tally.note = "too-large";
    if (r.reason !== "missing") tally.skip(r.reason);
    return undefined;
  }
  if (!isObj(r.value)) {
    tally.skip("parse");
    return undefined;
  }
  const v = r.value;
  const st = safeStat(file);
  tally.files++;
  tally.bytes += st?.size ?? 0;

  const uuid = field(v, "oauthAccount", isObj, tally)?.accountUuid;
  if (typeof uuid === "string" && uuid !== "") out({ k: "identity", tool: TOOL, source: CONFIG_SOURCE, scope: "config", hash: ctx.hash(uuid) });
  const queue = field(v, "promptQueueUseCount", isNum, tally);
  if (queue !== undefined && queue >= 0) {
    // a lifetime count of the CLI's own feature, without a date: a config use count, never a dated activity
    const ev = cfg("feature", "bundled", "prompt-queue");
    ev.uses = queue;
    out(ev);
  }
  const plan = toEpochMs(field(v, "lastPlanModeUse", isNum, tally), ctx.now);
  if (plan !== undefined) out({ k: "marker", tool: TOOL, source: CONFIG_SOURCE, ts: plan, kind: "plan-enter" });

  const plugins = new Map<string, number>();
  for (const [id, u] of usageTable(field(v, "pluginUsage", isObj, tally), "pluginUsage", tally, ctx)) plugins.set(id, u.uses);
  const mcpServers = new Set(Object.keys(field(v, "mcpServers", isObj, tally) ?? {}));
  for (const project of Object.values(field(v, "projects", isObj, tally) ?? {})) { // project paths (the keys) are never read
    if (!isObj(project)) continue;
    for (const name of Object.keys(field(project, "mcpServers", isObj, tally, "projects.mcpServers") ?? {})) mcpServers.add(name);
  }
  const g: GlobalUsage = { skills: usageTable(field(v, "skillUsage", isObj, tally), "skillUsage", tally, ctx), plugins, mcpServers };
  const first = toEpochMs(field(v, "firstStartTime", isStr, tally), ctx.now);
  if (first !== undefined) g.firstStart = first;
  return g;
}

/** settings.json hooks: one event per hook entry; a command hook's command is classified in memory and never kept. */
function hooks(settings: Obj | undefined, tally: Tally, out: Out): void {
  const table = settings ? field(settings, "hooks", isObj, tally) : undefined;
  for (const [event, groups] of Object.entries(table ?? {})) {
    const name = HOOK_EVENT.test(event) ? event : "other";
    if (!Array.isArray(groups)) {
      tally.unknownKey("hooks:shape");
      continue;
    }
    for (const group of groups) {
      const list = isObj(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
      if (!list) {
        tally.unknownKey("hooks:shape");
        continue;
      }
      for (const hook of list) {
        if (!isObj(hook)) {
          tally.unknownKey("hooks:shape");
          continue;
        }
        const ev = cfg("hook", "authored", name);
        if (typeof hook.command === "string") ev.checks = classifyCommand(hook.command).checks;
        out(ev);
      }
    }
  }
}

/** Skill names in `~/.agents/.skill-lock.json` (only the keys of `skills`): empty without a lock, undefined when it cannot be read. */
function lockedSkills(home: string, tally: Tally): Set<string> | undefined {
  const file = resolved(path.join(home, ".agents", ".skill-lock.json"));
  if (!safeStat(file)) return new Set();
  const v = readSidecar(file, tally);
  return v && new Set(Object.keys(field(v, "skills", isObj, tally, "skill-lock.skills") ?? {}));
}

/** Names of the `*.md` files directly in a folder, without the extension; the files are never opened. */
function markdownStems(dir: string, tally: Tally): string[] {
  return listDir(dir, tally).filter((f) => f.endsWith(".md") && !f.startsWith(".") && isFile(path.join(dir, f))).map((f) => f.slice(0, -3));
}

/**
 * Skills (`skills/<name>/SKILL.md`), commands (`commands/<name>.md`) and agents (`agents/<name>.md`), with the CLI's
 * usage counts joined by name: a skillUsage name goes to the skill folder of that name, else to the command file, else
 * it is a skill found nowhere on disk — installed when the skill lock lists it or it carries a `<plugin>:` prefix,
 * unknown otherwise (bundled with the CLI, project-level, or removed).
 */
function artifacts(c: Candidate, usage: GlobalUsage | undefined, tally: Tally, out: Out): void {
  const lock = lockedSkills(c.home, tally);
  const cache = realpathOf(path.join(c.root, "plugins", "cache"));
  const dir = path.join(c.root, "skills");
  const skills = new Map<string, ConfigEv>();
  for (const name of listDir(dir, tally)) {
    if (name.startsWith(".") || !isFile(path.join(dir, name, "SKILL.md"))) continue;
    const real = realpathOf(path.join(dir, name));
    const installed = lock?.has(name) || (cache !== undefined && real !== undefined && real.startsWith(cache + path.sep));
    skills.set(name, cfg("skill", installed ? "installed" : lock === undefined ? "unknown" : "authored", name));
  }
  const commands = new Map(markdownStems(path.join(c.root, "commands"), tally).map((n) => [n, cfg("command", "authored", n)] as const));
  for (const [name, u] of usage?.skills ?? []) {
    let ev = skills.get(name) ?? commands.get(name);
    if (!ev) skills.set(name, (ev = cfg("skill", lock?.has(name) || name.includes(":") ? "installed" : "unknown", name)));
    ev.uses = u.uses;
    if (u.lastUsed !== undefined) ev.lastUsed = u.lastUsed;
  }
  for (const ev of [...[...skills.keys()].sort(byName).map((n) => skills.get(n)!), ...commands.values()]) {
    if (usage) ev.uses ??= 0;
    out(ev);
  }
  for (const name of markdownStems(path.join(c.root, "agents"), tally)) out(cfg("agent", "authored", name));
}

/** Installed plugin ids (keys of installed_plugins.json `plugins`) and every id with usage, with pluginUsage counts. */
function plugins(c: Candidate, usage: GlobalUsage | undefined, tally: Tally, out: Out): void {
  const installed = readSidecar(resolved(path.join(c.root, "plugins", "installed_plugins.json")), tally);
  const ids = new Set(Object.keys((installed && field(installed, "plugins", isObj, tally, "installed_plugins.plugins")) ?? {}));
  for (const id of usage?.plugins.keys() ?? []) ids.add(id);
  for (const id of [...ids].sort(byName)) {
    const ev = cfg("plugin", "installed", id);
    if (usage) ev.uses = usage.plugins.get(id) ?? 0;
    out(ev);
  }
}

/** One event per `projects/<slug>/memory/*.md`, without a name; the files are never opened. */
function memoryFiles(root: string, tally: Tally, out: Out): void {
  const projects = path.join(root, "projects");
  for (const slug of listDir(projects, tally)) {
    for (const _ of markdownStems(path.join(projects, slug, "memory"), tally)) out(cfg("memory-file", "authored"));
  }
}

/** Configuration measured by use: global config usage tables, hooks, skills, commands, agents, plugins, MCP servers, memory. */
export async function scanConfig(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, CONFIG_SOURCE, "lifetime");
  const out: Out = (ev) => {
    tally.records++;
    if (ev.k === "marker") tally.span(ev.ts);
    ctx.emit(ev);
  };
  const usage = readGlobalConfig(resolved(globalConfigPath(c, ctx.env)), ctx, tally, out);
  hooks(readSidecar(resolved(path.join(c.root, "settings.json")), tally), tally, out);
  artifacts(c, usage, tally, out);
  plugins(c, usage, tally, out);
  for (const name of [...(usage?.mcpServers ?? [])].sort(byName)) out(cfg("mcp-server", "unknown", name));
  memoryFiles(c.root, tally, out);
  const cov = tally.coverage();
  if (usage?.firstStart !== undefined) cov.from = usage.firstStart;
  ctx.emit(cov);
}
