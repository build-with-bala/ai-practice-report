import { expect, test } from "bun:test";
import { classifyCommand } from "../../../core/text/commands";
import type { CheckKind, ToolCategory } from "../../../core/model/ids";

const rows: [string, ToolCategory, CheckKind[]][] = [
  ["cd app && bun test", "test", ["test"]],
  ["npm run build && npm test", "build", ["build", "test"]],
  ["tsc --noEmit", "typecheck", ["typecheck"]],
  ["tsc -p .", "build", ["build"]],
  ["git commit -m x", "git", []],
  ["docker compose up", "container", []],
  ["curl -s x", "network", []],
  ["ls -la", "shell", []],
  ["", "shell", []],
  ["   ", "shell", []],
  ["pytest -q tests/", "test", ["test"]],
  ["CI=1 npx vitest run", "test", ["test"]],
  ["sudo pnpm exec jest", "test", ["test"]],
  ["uv run pytest", "test", ["test"]],
  ["poetry run mypy src", "typecheck", ["typecheck"]],
  ["time cargo test --all", "test", ["test"]],
  ["go test ./...", "test", ["test"]],
  ["cargo build --release", "build", ["build"]],
  ["cargo clippy", "lint", ["lint"]],
  ["cargo check", "typecheck", ["typecheck"]],
  ["eslint . && prettier --check .", "lint", ["lint"]],
  ["ruff check . ; mypy .", "lint", ["lint", "typecheck"]],
  ["bunx biome check", "lint", ["lint"]],
  ["bun test | tee out.txt", "test", ["test"]],
  ["npm run lint || true", "shell", []],
  ["./gradlew test", "test", ["test"]],
  ["mvn -q test", "test", ["test"]],
  ["xcodebuild -scheme A test", "test", ["test"]],
  ["xcodebuild -scheme A build", "build", ["build"]],
  ["vite build", "build", ["build"]],
  ["npm install", "package", []],
  ["pip install -r r.txt", "package", []],
  ["brew install jq", "package", []],
  ["psql -c 'select 1'", "db", []],
  ["sqlite3 a.db .tables", "db", []],
  ["ssh host uptime", "network", []],
  ["terraform plan", "cloud", []],
  ["gh pr create", "git", []],
  ["kubectl get pods", "container", []],
  ["FOO=bar BAZ=1 bun test", "test", ["test"]],
  ["bun test && bun test", "test", ["test"]],
  ["cd x && git status && npm test", "test", ["test"]],
  ["echo hello", "shell", []],
];

test.each(rows)("classifyCommand(%j)", (cmd, category, checks) => {
  expect(classifyCommand(cmd)).toEqual({ category, checks });
});
test("at least 30 rows", () => expect(rows.length).toBeGreaterThanOrEqual(30));
