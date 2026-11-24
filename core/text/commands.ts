import type { CheckKind, ToolCategory, Toolchain } from "../model/ids";

type Check = CheckKind;
const JS_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/**
 * The toolchain of a command that runs checks, by its name (after wrappers and runners); `python -m <x>` is `py`
 * whatever x is. `php` runs checks only as `php artisan`, `python` only as `python manage.py test`. The script
 * runners (`turbo`, `nx`, `just`, `task`, `composer`) run a check when their script's name reads as one, as for
 * `npm run`. `nix` runs no check this classifier knows yet.
 */
const TOOLCHAINS: Readonly<Record<Toolchain, string>> = {
  js: "bun npm pnpm yarn deno vitest jest mocha ava karma eslint prettier biome tsc vue-tsc svelte-check vite next nuxt astro webpack esbuild rollup stylelint playwright cypress ng turbo nx",
  py: "pytest py.test tox nox unittest mypy pyright ruff flake8 pylint black isort python python3",
  go: "go golangci-lint gofmt",
  rust: "cargo rustfmt",
  jvm: "mvn mvnw gradle gradlew ktlint",
  dotnet: "dotnet",
  ruby: "rspec rake rubocop rails",
  php: "phpunit pest phpcs phpstan psalm composer php",
  swift: "swift xcodebuild swiftlint",
  dart: "dart flutter",
  native: "cmake ctest",
  shell: "shellcheck",
  any: "make just task pre-commit bazel bazelisk nix",
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
  ["time", NO_VALUES], ["nohup", NO_VALUES], ["exec", NO_VALUES],
  ["npx", new Set(["-p", "--package", "--cache", "--registry"])], ["bunx", new Set(["-p", "--package"])],
]);
/** `timeout [-s SIGNAL] [-k DURATION] DURATION <command>`. */
const TIMEOUT_VALUES: ReadonlySet<string> = new Set(["-s", "-k"]);
/** Runners whose second word runs the rest of the line as a command, after their own flags (those listed take a value). */
const RUNNER_PREFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["pnpm exec", NO_VALUES],
  ["uv run", new Set(["--with", "--with-editable", "--with-requirements", "--python", "-p", "--project", "--directory", "--package", "--extra",
    "--group", "--env-file", "--index"])],
  ["poetry run", NO_VALUES], ["pipenv run", NO_VALUES], ["hatch run", NO_VALUES], ["pdm run", new Set(["-p", "--project"])],
  ["bundle exec", NO_VALUES],
]);
/**
 * Container runners whose command runs inside a service or container named after their flags (those listed take a
 * value): `docker compose exec|run <service> …`, `docker-compose exec|run <service> …`, `docker exec <container> …`.
 */
const DOCKER_VALUES: ReadonlySet<string> = new Set(["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--name", "-v", "--volume",
  "--entrypoint", "-p", "--publish", "--network", "-l", "--label", "--index", "--profile", "-f", "--file", "--project-name"]);
/** How many words a container runner's prefix takes before its flags: 3 for `docker compose exec`, 2 for the others; 0 for none. */
function dockerPrefix(t: readonly string[], i: number): number {
  const h = baseName(t[i]!);
  if (h === "docker" && t[i + 1] === "compose" && (t[i + 2] === "exec" || t[i + 2] === "run")) return 3;
  if (h === "docker-compose" && (t[i + 1] === "exec" || t[i + 1] === "run")) return 2;
  if (h === "docker" && t[i + 1] === "exec") return 2;
  return 0;
}
/** Python's own flags before `-m <module>` or a script; those listed take a value. `-c` (a program string) ends them. */
const PYTHON_VALUES: ReadonlySet<string> = new Set(["-X", "-W", "--check-hash-based-pycs"]);
/** Command names that are another's wrapper script: the Maven wrapper runs Maven. */
const ALIASES: ReadonlyMap<string, string> = new Map([["mvnw", "mvn"]]);

/** Shells that run a script given as one argument, and the flag that gives it. */
const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);
const OTHER_SHELLS = new Set(["pwsh", "powershell", "cmd"]);
const POSIX_SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/;
const SCRIPT_FLAG = /^(?:-[A-Za-z]*c|\/c|-Command)$/i;
/** POSIX shell options that take a value (`bash -o pipefail -c …`). */
const SHELL_VALUES: ReadonlySet<string> = new Set(["-o", "+o", "-O", "+O"]);

/**
 * Where a shell's argv gives its script as one word: after `-c` (the POSIX shells, with any option letters around the
 * `c`: `-lc`, `-ec`; other options skipped), after `-Command` or `/c` (pwsh, cmd). For an argv that is exactly the
 * shell's (`runsOn` false), a script flag as the last-but-one word also counts. Undefined when there is none.
 */
function scriptAt(argv: readonly string[], runsOn: boolean): number | undefined {
  const shell = baseName(argv[0] ?? "").toLowerCase();
  const posix = POSIX_SHELLS.has(shell);
  if (!posix && !OTHER_SHELLS.has(shell)) return undefined;
  if (!runsOn && argv.length >= 3 && SCRIPT_FLAG.test(argv[argv.length - 2]!)) return argv.length - 1;
  const flag = posix ? POSIX_SCRIPT_FLAG : SCRIPT_FLAG;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (flag.test(a)) return i + 1 < argv.length ? i + 1 : undefined;
    if (posix && SHELL_VALUES.has(a)) i++;
    else if (!a.startsWith("-") && !a.startsWith("+")) return undefined;
  }
  return undefined;
}

/**
 * The script a shell runs when it is given as one argument, from the shell's argv (`bash -lc "<script>"`, `sh -c`,
 * `zsh -c`, `pwsh -Command`, `cmd /c`); undefined for any other argv. The one unwrap for every reader, so one command
 * reads the same in every tool.
 */
export function shellScript(argv: readonly string[]): string | undefined {
  const i = scriptAt(argv, false);
  return i === undefined ? undefined : argv[i];
}

/** A command line's words, quotes respected: each word's span in the line, its value unquoted, and whether it held a quote. */
interface Word { from: number; to: number; value: string; quoted: boolean }
function wordsOf(s: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const from = i;
    let value = "";
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i]!)) {
      const c = s[i]!;
      if (c === "'") {
        quoted = true;
        const end = s.indexOf("'", i + 1);
        const stop = end < 0 ? s.length : end;
        value += s.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === '"') {
        // inside double quotes a backslash escapes `"`, `\\`, `$` and a backquote
        quoted = true;
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) i++;
          value += s[i];
          i++;
        }
        i++;
      } else if (c === "\\" && i + 1 < s.length) {
        value += s[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    out.push({ from, to: Math.min(i, s.length), value, quoted });
  }
  return out;
}

/** At most this many words after a shell's name are searched for its script, so a line of many shells stays linear. */
const SHELL_WINDOW = 16;

/**
 * The command line with each shell given its script as one quoted word (`bash -lc "npm test"`) replaced by that
 * script, so the commands inside are classified, not blanked as quoted data. Nested shells are unwrapped too, a few
 * levels deep.
 */
function unwrapShells(line: string): string {
  for (let depth = 0; depth < 4; depth++) {
    const words = wordsOf(line);
    let changed = false;
    for (let w = 0; w < words.length && !changed; w++) {
      const shell = baseName(words[w]!.value).toLowerCase();
      if (!POSIX_SHELLS.has(shell) && !OTHER_SHELLS.has(shell)) continue;
      const window = words.slice(w, w + SHELL_WINDOW);
      const at = scriptAt(window.map((x) => x.value), true);
      if (at === undefined || !window[at]!.quoted) continue;
      line = `${line.slice(0, words[w]!.from)}${window[at]!.value}${line.slice(window[at]!.to)}`;
      changed = true;
    }
    if (!changed) break;
  }
  return line;
}

/** A segment's command: its name and arguments, and whether it ran as `python -m <name>`. */
interface Command { name: string; args: string[]; python: boolean }

/** A token's command name: its last path part, without a Windows program extension. */
const baseName = (token: string): string => token.split(/[\\/]/).pop()!.replace(/\.(exe|bat|cmd)$/i, "");

/** The index after a run of flags starting at `i`; a flag in `valued` takes the token after it as its value. */
function skipFlags(t: readonly string[], i: number, valued: ReadonlySet<string>): number {
  while (t[i]?.startsWith("-")) i += valued.has(t[i]!) ? 2 : 1;
  return i;
}

/** The verbs that run a package script by name. */
const SCRIPT_VERBS = new Set(["run", "run-script"]);

/**
 * Where a JS package runner names a tool of the toolchain table — after `workspace <name>` and one of `run`,
 * `run-script`, `exec`, `x` — the index of that tool among the tokens after the runner (`t[from]`), else -1: `pnpm vitest run`,
 * `npm exec eslint .`, `bun x tsc`, and a package script named like the tool (`npm run eslint`), which runs as that tool.
 * A script reached through `run`/`run-script` whose name `scriptCheck` already reads keeps that reading (`npm run tsc`
 * is the project's typecheck script), so it is no tool here.
 */
function runnerTool(t: readonly string[], from: number): number {
  const at = positionalIndexes(t, from + 1);
  let k = t[at[0] ?? -1] === "workspace" ? 2 : 0;
  const verb = t[at[k] ?? -1] ?? "";
  if (RUNNER_VERBS.has(verb)) k++;
  const i = at[k];
  if (i === undefined || !RUNNER_TOOLS.has(baseName(t[i]!))) return -1;
  return SCRIPT_VERBS.has(verb) && scriptCheck(t[i]!).length > 0 ? -1 : i;
}

/**
 * Strip env assignments, wrappers (with their flags) and runners; `python -m <x>` is read as x. The leading words are
 * walked by index, so a line of many wrappers costs linear time.
 */
function commandOf(tokens: string[]): Command {
  // a subshell's or a group's brackets, opening or closing, are no part of a word: `(cd web && npm test)`
  const t = tokens.map((x) => x.replace(/^[({]+/, "").replace(/[)}]+$/, "")).filter(Boolean);
  let i = 0;
  for (;;) {
    const h = t[i];
    if (h === undefined) return { name: "", args: [], python: false };
    if (/^[A-Za-z_]\w*=/.test(h)) { i++; continue; }
    const valued = WRAPPERS.get(h);
    if (valued) { i = skipFlags(t, i + 1, valued); continue; }
    if (h === "timeout") { i = skipFlags(t, i + 1, TIMEOUT_VALUES) + 1; continue; } // its flags, then the duration
    const prefix = RUNNER_PREFIXES.get(`${h} ${t[i + 1] ?? ""}`);
    if (prefix) { i = skipFlags(t, i + 2, prefix); continue; }
    const docker = dockerPrefix(t, i);
    if (docker > 0) {
      const service = skipFlags(t, i + docker, DOCKER_VALUES);
      if (t[service + 1] !== undefined) { i = service + 1; continue; } // the service or container, then its command
    }
    if (JS_RUNNERS.has(baseName(h))) {
      const tool = runnerTool(t, i);
      if (tool > i) { i = tool; continue; }
    }
    break;
  }
  const raw = baseName(t[i]!);
  const name = ALIASES.get(raw) ?? raw;
  if (name === "python" || name === "python3") {
    const j = skipPythonFlags(t, i + 1);
    if (t[j] === "-m" && t[j + 1]) return { name: t[j + 1]!, args: t.slice(j + 2), python: true };
    return { name, args: t.slice(j), python: false };
  }
  return { name, args: t.slice(i + 1), python: false };
}

/** The index after python's own flags from `i` (`-u`, `-X dev`, `-W error`, …); `-c` and `-m` end them, as does a script. */
function skipPythonFlags(t: readonly string[], i: number): number {
  while (t[i]?.startsWith("-") && t[i] !== "-m" && t[i] !== "-c") i += PYTHON_VALUES.has(t[i]!) ? 2 : 1;
  return i;
}

/** The indexes, from `from` on, of the positional tokens (not flags, nor the values of FLAGS_WITH_VALUE). */
function positionalIndexes(args: readonly string[], from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i < args.length; i++) {
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

/** The checks of a script runner's scripts, each read as `npm run <script>` reads its one: the union, in order. */
function scriptsCheck(names: readonly string[]): Check[] {
  const out: Check[] = [];
  for (const n of names) for (const c of scriptCheck(n)) if (!out.includes(c)) out.push(c);
  return out;
}

function checksOf(cmd: string, args: string[]): Check[] {
  if (args.length && args.every((a) => HELP_ONLY.has(a))) return [];
  const p = positionals(args);
  const a1 = p[0];
  const has = (f: string) => args.includes(f);
  if (JS_RUNNERS.has(cmd)) return a1 ? scriptCheck(jsScript(args) ?? "") : [];
  // script runners: `turbo [run] <task>…`, `nx <target> [project]`, `nx run <project>:<target>`, `just <recipe>`,
  // `task <task>`, `composer [run] <script>`
  if (cmd === "turbo") return scriptsCheck(a1 === "run" ? p.slice(1) : p);
  if (cmd === "nx") return a1 === "run" ? scriptsCheck(p[1] === undefined ? [] : [p[1].split(":").at(-1)!]) : scriptsCheck(a1 === undefined ? [] : [a1]);
  if (cmd === "just" || cmd === "task") return scriptsCheck(a1 === undefined ? [] : [a1]);
  if (cmd === "composer") return scriptsCheck(a1 === "run" || a1 === "run-script" ? p.slice(1, 2) : p.slice(0, 1));
  if ((cmd === "python" || cmd === "python3") && baseName(a1 ?? "") === "manage.py") return p[1] === "test" ? ["test"] : [];
  if (cmd === "rails") return a1 === "test" || a1 === "test:system" ? ["test"] : [];
  if (cmd === "ng") return a1 === "test" || a1 === "e2e" ? ["test"] : a1 === "build" ? ["build"] : a1 === "lint" ? ["lint"] : [];
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
  if (cmd === "cargo") {
    return a1 === "clippy" ? ["lint"] : a1 === "check" ? ["typecheck"] : a1 === "fmt" && args.includes("--check") ? ["lint"] : a1 === "nextest" ? ["test"] : [];
  }
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
  for (const raw of blankQuotes(dropHeredocs(unwrapShells(cmd))).split(/&&|\|\||;|\||\n/)) {
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
