import type { CheckKind, ToolCategory } from "../model/ids";

type Check = CheckKind;
const JS_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BARE_TEST = new Set(["pytest", "py.test", "vitest", "jest", "mocha", "ava", "karma", "rspec", "phpunit", "pest", "tox", "nox", "ctest", "unittest"]);
const SUB_TEST = new Set(["go", "cargo", "swift", "deno", "dotnet", "flutter", "dart", "bazel", "bazelisk", "mix", "zig", "stack", "cabal", "lein", "sbt"]);
const SUB_BUILD = new Set(["cargo", "go", "swift", "zig", "flutter", "dotnet"]);
const BARE_BUILD = new Set(["webpack", "esbuild", "rollup"]);
const BARE_LINT = new Set(["eslint", "flake8", "pylint", "golangci-lint", "stylelint", "shellcheck", "rubocop", "ktlint", "swiftlint", "markdownlint", "hadolint", "phpcs", "ruff"]);
const BARE_TYPECHECK = new Set(["mypy", "pyright", "svelte-check", "phpstan", "psalm"]);
const SUB_BUILD_TOOLS = new Set(["vite", "next", "nuxt", "astro"]);

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

/** Strip env assignments and wrapper commands; return [command basename, args]. */
function commandOf(tokens: string[]): [string, string[]] {
  let t = tokens.map((x) => x.replace(/^[({]+/, "")).filter(Boolean);
  for (;;) {
    const h = t[0];
    if (h === undefined) return ["", []];
    if (/^[A-Za-z_]\w*=/.test(h)) { t = t.slice(1); continue; }
    if (["sudo", "time", "nohup", "exec", "env"].includes(h)) { t = t.slice(1); while (t[0]?.startsWith("-")) t = t.slice(1); continue; }
    if (h === "npx" || h === "bunx") { t = t.slice(1); while (t[0]?.startsWith("-")) t = t.slice(1); continue; }
    if (h === "timeout") {
      t = t.slice(1);
      while (t[0]?.startsWith("-")) t = t.slice(t[0] === "-s" || t[0] === "-k" ? 2 : 1);
      t = t.slice(1);
      continue;
    }
    const two = `${h} ${t[1] ?? ""}`;
    if (["pnpm exec", "uv run", "poetry run", "pipenv run", "hatch run", "bundle exec"].includes(two)) { t = t.slice(2); continue; }
    break;
  }
  let cmd = t[0]!.split(/[\\/]/).pop()!.replace(/\.(exe|bat|cmd)$/i, "");
  let args = t.slice(1);
  if ((cmd === "python" || cmd === "python3") && args[0] === "-m" && args[1]) { cmd = args[1]; args = args.slice(2); }
  return [cmd, args];
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (FLAGS_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

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

export function classifyCommand(cmd: string): { category: ToolCategory; checks: CheckKind[] } {
  const checks: CheckKind[] = [];
  let category: ToolCategory | undefined;
  for (const raw of blankQuotes(cmd).split(/&&|\|\||;|\||\n/)) {
    const [c, args] = commandOf(raw.trim().split(/\s+/).filter(Boolean));
    if (!c) continue;
    for (const k of [...checksOf(c, args), ...extraChecks(c, args)]) if (!checks.includes(k)) checks.push(k);
    category ??= categoryOf(c, args);
  }
  return { category: checks[0] ?? category ?? "shell", checks };
}
