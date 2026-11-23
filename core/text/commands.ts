import type { CheckKind, ToolCategory, Toolchain } from "../model/ids";

type Check = CheckKind;
const JS_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/**
 * The toolchain of a command that runs checks, by its name (after wrappers and runners); `python -m <x>` is `py`
 * whatever x is. `php` runs checks only as `php artisan`. `just` and `nix` run no check this classifier knows yet.
 */
const TOOLCHAINS: Readonly<Record<Toolchain, string>> = {
  js: "bun npm pnpm yarn deno vitest jest mocha ava karma eslint prettier biome tsc vue-tsc svelte-check vite next nuxt astro webpack esbuild rollup stylelint playwright cypress",
  py: "pytest py.test tox nox unittest mypy pyright ruff flake8 pylint black isort",
  go: "go golangci-lint gofmt",
  rust: "cargo rustfmt",
  jvm: "mvn gradle gradlew ktlint",
  dotnet: "dotnet",
  ruby: "rspec rake rubocop",
  php: "phpunit pest phpcs phpstan psalm composer php",
  swift: "swift xcodebuild swiftlint",
  dart: "dart flutter",
  native: "cmake ctest",
  shell: "shellcheck",
  any: "make just pre-commit bazel bazelisk nix",
};
const TOOLCHAIN_OF: ReadonlyMap<string, Toolchain> = new Map(
  (Object.entries(TOOLCHAINS) as [Toolchain, string][]).flatMap(([toolchain, names]) => names.split(" ").map((n) => [n, toolchain] as const)),
);
/** The tools a JS package runner runs by name (`pnpm vitest run`): every command the toolchain table names but the runners. */
const RUNNER_TOOLS: ReadonlySet<string> = new Set([...TOOLCHAIN_OF.keys()].filter((n) => !JS_RUNNERS.has(n)));
/** What may stand between a JS package runner and the tool it runs: `run` (`run-script`), `exec`, `x`. */
const RUNNER_VERBS = new Set(["run", "run-script", "exec", "x"]);
const BARE_TEST = new Set(["pytest", "py.test", "vitest", "jest", "mocha", "ava", "karma", "rspec", "phpunit", "pest", "tox", "nox", "ctest", "unittest"]);
const SUB_TEST = new Set(["go", "cargo", "swift", "deno", "dotnet", "flutter", "dart", "bazel", "bazelisk", "mix", "zig", "stack", "cabal", "lein", "sbt"]);
const SUB_BUILD = new Set(["cargo", "go", "swift", "zig", "flutter", "dotnet"]);
const BARE_BUILD = new Set(["webpack", "esbuild", "rollup"]);
const BARE_LINT = new Set(["eslint", "flake8", "pylint", "golangci-lint", "stylelint", "shellcheck", "rubocop", "ktlint", "swiftlint", "markdownlint", "hadolint", "phpcs", "ruff"]);
const BARE_TYPECHECK = new Set(["mypy", "pyright", "svelte-check", "phpstan", "psalm"]);
const SUB_BUILD_TOOLS = new Set(["vite", "next", "nuxt", "astro"]);
/** Commands that only search or only read files; they rank behind every other category in the same command line. */
const SEARCH = new Set(["rg", "grep", "ag", "ack", "fd", "find"]);
const READ = new Set(["cat", "head", "tail", "less", "more", "bat", "wc", "nl", "stat", "ls", "tree"]);
/** `find` actions that delete files or run commands: such a find is not a search. */
const FIND_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir)$/;
/** Commands that only print what they are given; with their output sent to a file they write it. */
const PRINT = new Set(["echo", "printf"]);
/**
 * Output sent into a file: `> f`, `>> f`, `1> f`, `&> f` — not `2> f` (errors only), `>&2` (another stream) or
 * `/dev/null`. Run on a command whose quoted spans are blanked, so a `>` inside quotes is never seen.
 */
const WRITE_REDIRECT = /(?:^|[^0-9&<>])(?:1|&)?>>?(?!&)\s*(?!\/dev\/null(?:\s|$))[^\s&|;<>]/;
/** A heredoc's delimiter after `<<` or `<<-`: a quoted word, or a bare word that starts like a name (so `1 << 2` is a shift). */
const HEREDOC_WORD = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

/**
 * The command line without its heredoc bodies. Each `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` outside quotes (not
 * a `<<<` here-string) makes the lines after its own line, up to the line that is exactly WORD (after leading tabs for
 * `<<-`), the text fed to the command — data, never commands — so they are dropped with their terminator. Several
 * heredocs on one line take their bodies in order; a body never terminated runs to the end.
 */
function dropHeredocs(s: string): string {
  if (!s.includes("<<")) return s;
  const out: string[] = [];
  const pending: { word: string; tabs: boolean }[] = [];
  let q = "";
  for (const line of s.split("\n")) {
    const body = pending[0];
    if (body) {
      const t = line.replace(/\r$/, "");
      if ((body.tabs ? t.replace(/^\t+/, "") : t) === body.word) pending.shift();
      continue;
    }
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!;
      if (q) {
        if (c === q) q = "";
        else if (c === "\\" && q === '"') j++;
      } else if (c === '"' || c === "'") q = c;
      else if (c === "\\") j++;
      else if (line.startsWith("<<<", j)) j += 2;
      else if (line.startsWith("<<", j)) {
        let k = j + 2;
        const tabs = line[k] === "-";
        if (tabs) k++;
        while (line[k] === " " || line[k] === "\t") k++;
        const m = HEREDOC_WORD.exec(line.slice(k));
        if (m) {
          pending.push({ word: m[1] ?? m[2] ?? m[3]!, tabs });
          j = k + m[0].length - 1;
        } else j++;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

const CATEGORY_BY_CMD: Record<string, ToolCategory> = {
  git: "git", gh: "git",
  pip: "package", pip3: "package", uv: "package", brew: "package", apt: "package", "apt-get": "package",
  docker: "container", "docker-compose": "container", podman: "container", kubectl: "container", helm: "container",
  psql: "db", mysql: "db", sqlite3: "db", mongosh: "db", "redis-cli": "db", pg_dump: "db",
  curl: "network", wget: "network", ssh: "network", scp: "network", rsync: "network", dig: "network", nc: "network",
  aws: "cloud", gcloud: "cloud", az: "cloud", terraform: "cloud", vercel: "cloud", netlify: "cloud", flyctl: "cloud", coolify: "cloud",
};

/** Blank the contents of quoted spans (keeping the quote characters) so later splitting/matching ignores them. */
function blankQuotes(s: string): string {
  let out = "";
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!q) {
      if (c === '"' || c === "'") q = c;
      out += c;
    } else if (c === q) {
      q = "";
      out += c;
    } else if (c === "\\" && q === '"' && i + 1 < s.length) {
      out += "  ";
      i++;
    } else out += " ";
  }
  return out;
}

const HELP_ONLY = new Set(["-v", "--version", "-h", "--help"]);
const FLAGS_WITH_VALUE = new Set(["--filter", "-F", "--prefix", "-w", "--workspace", "-C", "--cwd", "--dir"]);
const NO_VALUES: ReadonlySet<string> = new Set();
/** Commands that run the command after their own flags; the flags listed take a value, which is skipped with them. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-C", "-h", "-p"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["nice", new Set(["-n"])],
  ["time", NO_VALUES], ["nohup", NO_VALUES], ["exec", NO_VALUES], ["npx", NO_VALUES], ["bunx", NO_VALUES],
]);
/** `timeout [-s SIGNAL] [-k DURATION] DURATION <command>`. */
const TIMEOUT_VALUES: ReadonlySet<string> = new Set(["-s", "-k"]);
/** Runners whose second word runs the rest of the line as a command. */
const RUNNER_PREFIXES = new Set(["pnpm exec", "uv run", "poetry run", "pipenv run", "hatch run", "bundle exec"]);

/** A segment's command: its name and arguments, and whether it ran as `python -m <name>`. */
interface Command { name: string; args: string[]; python: boolean }

/** A token's command name: its last path part, without a Windows program extension. */
const baseName = (token: string): string => token.split(/[\\/]/).pop()!.replace(/\.(exe|bat|cmd)$/i, "");

/** The tokens after a leading run of flags; a flag in `valued` takes the token after it as its value. */
function afterFlags(t: string[], valued: ReadonlySet<string>): string[] {
  let i = 0;
  while (t[i]?.startsWith("-")) i += valued.has(t[i]!) ? 2 : 1;
  return t.slice(i);
}

/** The verbs that run a package script by name. */
const SCRIPT_VERBS = new Set(["run", "run-script"]);

/**
 * Where a JS package runner names a tool of the toolchain table — after `workspace <name>` and one of `run`,
 * `run-script`, `exec`, `x` — the index of that tool among the runner's tokens (`t[0]`), else -1: `pnpm vitest run`,
 * `npm exec eslint .`, `bun x tsc`, and a package script named like the tool (`npm run eslint`), which runs as that tool.
 * A script reached through `run`/`run-script` whose name `scriptCheck` already reads keeps that reading (`npm run tsc`
 * is the project's typecheck script), so it is no tool here.
 */
function runnerTool(t: string[]): number {
  const at = positionalIndexes(t).filter((i) => i > 0);
  let k = t[at[0] ?? -1] === "workspace" ? 2 : 0;
  const verb = t[at[k] ?? -1] ?? "";
  if (RUNNER_VERBS.has(verb)) k++;
  const i = at[k];
  if (i === undefined || !RUNNER_TOOLS.has(baseName(t[i]!))) return -1;
  return SCRIPT_VERBS.has(verb) && scriptCheck(t[i]!).length > 0 ? -1 : i;
}

/** Strip env assignments, wrappers (with their flags) and runners; `python -m <x>` is read as x. */
function commandOf(tokens: string[]): Command {
  let t = tokens.map((x) => x.replace(/^[({]+/, "")).filter(Boolean);
  for (;;) {
    const h = t[0];
    if (h === undefined) return { name: "", args: [], python: false };
    if (/^[A-Za-z_]\w*=/.test(h)) { t = t.slice(1); continue; }
    const valued = WRAPPERS.get(h);
    if (valued) { t = afterFlags(t.slice(1), valued); continue; }
    if (h === "timeout") { t = afterFlags(t.slice(1), TIMEOUT_VALUES).slice(1); continue; } // its flags, then the duration
    if (RUNNER_PREFIXES.has(`${h} ${t[1] ?? ""}`)) { t = t.slice(2); continue; }
    if (JS_RUNNERS.has(baseName(h))) {
      const tool = runnerTool(t);
      if (tool > 0) { t = t.slice(tool); continue; }
    }
    break;
  }
  const name = baseName(t[0]!);
  const args = t.slice(1);
  if ((name === "python" || name === "python3") && args[0] === "-m" && args[1]) return { name: args[1], args: args.slice(2), python: true };
  return { name, args, python: false };
}

/** The indexes of the positional tokens (not flags, nor the values of FLAGS_WITH_VALUE). */
function positionalIndexes(args: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (FLAGS_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith("-")) out.push(i);
  }
  return out;
}

const positionals = (args: string[]): string[] => positionalIndexes(args).map((i) => args[i]!);

function jsScript(args: string[]): string | undefined {
  let p = positionals(args);
  if (p[0] === "workspace") p = p.slice(2);
  if (p[0] === "run" || p[0] === "run-script") p = p.slice(1);
  return p[0];
}

function scriptCheck(s: string): Check[] {
  if (s === "t" || /^test([:-].*)?$/.test(s)) return ["test"];
  if (/^lint([:-].*)?$/.test(s)) return ["lint"];
  if (/^(typecheck|type-check|check-types)([:-].*)?$/.test(s) || ["tsc", "types", "check"].includes(s)) return ["typecheck"];
  if (/^build([:-].*)?$/.test(s)) return ["build"];
  return [];
}

function gradleChecks(tasks: string[]): Check[] {
  const out: Check[] = [];
  for (const raw of tasks) {
    const t = (raw.split(":").pop() ?? "").toLowerCase();
    if (t.includes("test") || t === "check") out.push("test");
    else if (t.startsWith("lint")) out.push("lint");
    else if (t.startsWith("assemble") || t.startsWith("bundle") || t === "build") out.push("build");
  }
  return out;
}

function checksOf(cmd: string, args: string[]): Check[] {
  if (args.length && args.every((a) => HELP_ONLY.has(a))) return [];
  const p = positionals(args);
  const a1 = p[0];
  const has = (f: string) => args.includes(f);
  if (JS_RUNNERS.has(cmd)) return a1 ? scriptCheck(jsScript(args) ?? "") : [];
  if (BARE_TEST.has(cmd)) return ["test"];
  if (SUB_TEST.has(cmd) && a1 === "test") return ["test"];
  if (SUB_BUILD.has(cmd) && a1 === "build") return ["build"];
  if (BARE_BUILD.has(cmd)) return ["build"];
  if (SUB_BUILD_TOOLS.has(cmd)) return a1 === "build" ? ["build"] : cmd === "next" && a1 === "lint" ? ["lint"] : [];
  if (BARE_LINT.has(cmd)) return ["lint"];
  if (BARE_TYPECHECK.has(cmd)) return ["typecheck"];
  switch (cmd) {
    case "tsc": return has("--noEmit") ? ["typecheck"] : ["build"];
    case "vue-tsc": return has("--noEmit") ? ["typecheck"] : ["build"];
    case "playwright": return a1 === "test" ? ["test"] : [];
    case "cypress": return a1 === "run" ? ["test"] : [];
    case "rake": return a1 === "test" || a1 === "spec" ? ["test"] : [];
    case "php": return p[0] === "artisan" && p[1] === "test" ? ["test"] : [];
    case "composer": return a1 === "test" ? ["test"] : [];
    case "xcodebuild": return args.includes("test") ? ["test"] : ["build"];
    case "cmake": return has("--build") ? ["build"] : [];
    case "make": {
      const targets = p.filter((x) => !x.includes("="));
      if (!targets.length) return ["build"];
      return targets.flatMap((x): Check[] => ["test", "tests", "check"].includes(x) ? ["test"] : x === "lint" ? ["lint"] : ["build", "all", "release", "dist"].includes(x) ? ["build"] : []);
    }
    case "gradlew": case "gradle": return gradleChecks(p);
    case "mvn": return p.flatMap((x): Check[] => x === "test" || x === "verify" ? ["test"] : ["package", "install", "compile"].includes(x) ? ["build"] : []);
    case "biome": return ["check", "lint", "ci"].includes(a1 ?? "") ? ["lint"] : [];
    case "prettier": return has("--check") ? ["lint"] : [];
    case "black": return has("--check") ? ["lint"] : [];
    case "isort": return has("--check") || has("--check-only") ? ["lint"] : [];
    case "rustfmt": return has("--check") ? ["lint"] : [];
    case "gofmt": return has("-l") ? ["lint"] : [];
    case "pre-commit": return a1 === "run" ? ["lint"] : [];
    case "dotnet": return a1 === "format" && has("--verify-no-changes") ? ["lint"] : [];
    case "dart": case "flutter": return a1 === "analyze" ? ["lint"] : [];
    case "flow": return a1 === "check" ? ["typecheck"] : [];
    default: break;
  }
  return [];
}

function extraChecks(cmd: string, args: string[]): Check[] {
  const a1 = positionals(args)[0];
  if (cmd === "cargo") return a1 === "clippy" ? ["lint"] : a1 === "check" ? ["typecheck"] : a1 === "fmt" && args.includes("--check") ? ["lint"] : [];
  if (cmd === "go") return a1 === "vet" ? ["typecheck"] : [];
  if (cmd === "deno") return a1 === "lint" ? ["lint"] : a1 === "check" ? ["typecheck"] : [];
  return [];
}

function categoryOf(cmd: string, args: string[]): ToolCategory | undefined {
  if (JS_RUNNERS.has(cmd)) return ["install", "i", "add", "remove"].includes(positionals(args)[0] ?? "") ? "package" : undefined;
  if ((cmd === "poetry" || cmd === "cargo") && positionals(args)[0] === "add") return "package";
  if (cmd === "poetry" && ["install", "remove"].includes(positionals(args)[0] ?? "")) return "package";
  return CATEGORY_BY_CMD[cmd];
}

/** `read` or `search` for a command that only reads or searches files; undefined otherwise. */
function passiveOf(cmd: string, args: string[]): ToolCategory | undefined {
  if (cmd === "find") return args.some((a) => FIND_ACTIONS.test(a)) ? undefined : "search";
  return SEARCH.has(cmd) ? "search" : READ.has(cmd) ? "read" : undefined;
}

/**
 * Whether a command writes a file with what it prints: a printing or reading command (`echo`, `printf`, `cat`, `head`,
 * …) whose output is sent into a file (`cat <<EOF > a.ts`), or `tee` naming a file.
 */
function writesFile(cmd: string, args: string[], segment: string): boolean {
  if (cmd === "tee") return positionals(args).length > 0;
  return (PRINT.has(cmd) || READ.has(cmd)) && WRITE_REDIRECT.test(segment);
}

/**
 * Category, checks and toolchain of a command line. Quoted spans and heredoc bodies are data, never commands. The checks
 * of every command in the line count; the category is the first check, else the first command's own category (git,
 * package, …), else `write` when a command writes a file with what it prints, else `read`/`search`, else `shell`. The
 * toolchain is that of the command that produced the first check (`TOOLCHAINS`); absent without checks, or when the
 * table names no toolchain for that command.
 */
export function classifyCommand(cmd: string): { category: ToolCategory; checks: CheckKind[]; toolchain?: Toolchain } {
  const checks: CheckKind[] = [];
  let toolchain: Toolchain | undefined;
  let category: ToolCategory | undefined;
  let written = false;
  let passive: ToolCategory | undefined;
  for (const raw of blankQuotes(dropHeredocs(cmd)).split(/&&|\|\||;|\||\n/)) {
    const { name, args, python } = commandOf(raw.trim().split(/\s+/).filter(Boolean));
    if (!name) continue;
    const first = checks.length === 0;
    for (const k of [...checksOf(name, args), ...extraChecks(name, args)]) if (!checks.includes(k)) checks.push(k);
    if (first && checks.length > 0) toolchain = python ? "py" : TOOLCHAIN_OF.get(name);
    category ??= categoryOf(name, args);
    written ||= writesFile(name, args, raw);
    passive ??= passiveOf(name, args);
  }
  const out: { category: ToolCategory; checks: CheckKind[]; toolchain?: Toolchain } = {
    category: checks[0] ?? category ?? (written ? "write" : undefined) ?? passive ?? "shell", checks,
  };
  if (toolchain !== undefined) out.toolchain = toolchain;
  return out;
}
