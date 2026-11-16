import type { CheckKind, ToolCategory } from "../model/ids";

const RE_TEST = /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\b(pytest|vitest|jest|mocha|ava|go test|cargo test|rspec|phpunit|playwright test|cypress run|tox|nox|dotnet test|deno test|swift test|ctest)\b|\b(mvn|gradlew?)\b.*\btest\b|\bxcodebuild\b.*\btest\b/;
const RE_BUILD = /\b(bun build|npm run build|pnpm (run )?build|yarn build|vite build|next build|cargo build|go build|make|cmake --build|xcodebuild|dotnet build|webpack|esbuild|swift build)\b|\btsc\b(?!.*--noEmit)|\b(mvn|gradlew?)\b.*\b(package|install|assemble|build)\b/;
const RE_LINT = /\b(eslint|biome (check|lint)|ruff|flake8|pylint|golangci-lint|cargo clippy|prettier --check|stylelint|shellcheck|rubocop|ktlint|swiftlint)\b/;
const RE_TYPECHECK = /\btsc\b.*--noEmit|\b(mypy|pyright|cargo check|go vet|flow check)\b/;

const CATEGORY_RES: [ToolCategory, RegExp][] = [
  ["git", /^\s*git\b|\bgh\s/],
  ["package", /\b(npm|pnpm|yarn|bun) (install|i|add|remove)\b|\bpip3?\b|\buv\b|\bpoetry\b|\bcargo add\b|\bbrew\b|\bapt(-get)?\b/],
  ["container", /\b(docker|podman|kubectl|helm|compose)\b/],
  ["db", /\b(psql|mysql|sqlite3|mongosh|redis-cli|pg_dump)\b/],
  ["network", /\b(curl|wget|ssh|scp|rsync|dig|nc)\b/],
  ["cloud", /\b(aws|gcloud|az|terraform|vercel|netlify|flyctl|coolify)\b/],
];

const RE_ENV = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const RE_WRAPPER = /^(sudo|time|npx|bunx|pnpm exec|uv run|poetry run)\s+/;

function stripPrefixes(seg: string): string {
  let s = seg.trim();
  for (;;) {
    const next = s.replace(RE_ENV, "").replace(RE_WRAPPER, "");
    if (next === s) return s;
    s = next.trimStart();
  }
}

export function classifyCommand(cmd: string): { category: ToolCategory; checks: CheckKind[] } {
  const checks: CheckKind[] = [];
  let category: ToolCategory | undefined;
  const add = (k: CheckKind) => { if (!checks.includes(k)) checks.push(k); };
  for (const raw of cmd.split(/&&|\|\||;|\|/)) {
    const seg = stripPrefixes(raw);
    if (!seg) continue;
    const isTest = RE_TEST.test(seg);
    if (isTest) add("test");
    // `xcodebuild … test` is a test run, not also a build.
    if (RE_BUILD.test(seg) && !(isTest && /\bxcodebuild\b/.test(seg))) add("build");
    if (RE_LINT.test(seg)) add("lint");
    if (RE_TYPECHECK.test(seg)) add("typecheck");
    if (!category) category = CATEGORY_RES.find(([, re]) => re.test(seg))?.[0];
  }
  return { category: checks[0] ?? category ?? "shell", checks };
}
