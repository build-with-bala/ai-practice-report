import { expect, test } from "bun:test";
import { classifyCommand } from "../../../core/text/commands";
import type { CheckKind, ToolCategory, Toolchain } from "../../../core/model/ids";

/** Command line, category, checks, and the toolchain of the command that produced the first check (none without checks). */
const rows: [string, ToolCategory, CheckKind[], Toolchain?][] = [
  // a JS package runner followed by a tool runs that tool; wrapper flags that take a value are skipped with it
  ["cd web && pnpm vitest run", "test", ["test"], "js"],
  ["uv run pytest -q", "test", ["test"], "py"],
  ["env -u FOO npm test", "test", ["test"], "js"],
  ["sudo -u ci pytest", "test", ["test"], "py"],
  ["cd app && bun test", "test", ["test"], "js"],
  ["npm run build && npm test", "build", ["build", "test"], "js"],
  ["tsc --noEmit", "typecheck", ["typecheck"], "js"],
  ["tsc -p .", "build", ["build"], "js"],
  ["git commit -m x", "git", []],
  ["docker compose up", "container", []],
  ["curl -s x", "network", []],
  ["ls -la", "read", []],
  ["", "shell", []],
  ["   ", "shell", []],
  ["pytest -q tests/", "test", ["test"], "py"],
  ["CI=1 npx vitest run", "test", ["test"], "js"],
  ["sudo pnpm exec jest", "test", ["test"], "js"],
  ["uv run pytest", "test", ["test"], "py"],
  ["poetry run mypy src", "typecheck", ["typecheck"], "py"],
  ["time cargo test --all", "test", ["test"], "rust"],
  ["go test ./...", "test", ["test"], "go"],
  ["cargo build --release", "build", ["build"], "rust"],
  ["cargo clippy", "lint", ["lint"], "rust"],
  ["cargo check", "typecheck", ["typecheck"], "rust"],
  ["eslint . && prettier --check .", "lint", ["lint"], "js"],
  ["ruff check . ; mypy .", "lint", ["lint", "typecheck"], "py"],
  ["bunx biome check", "lint", ["lint"], "js"],
  ["bun test | tee out.txt", "test", ["test"], "js"],
  ["npm run lint || true", "lint", ["lint"], "js"],
  ["./gradlew test", "test", ["test"], "jvm"],
  ["mvn -q test", "test", ["test"], "jvm"],
  ["xcodebuild -scheme A test", "test", ["test"], "swift"],
  ["xcodebuild -scheme A build", "build", ["build"], "swift"],
  ["vite build", "build", ["build"], "js"],
  ["npm install", "package", []],
  ["pip install -r r.txt", "package", []],
  ["brew install jq", "package", []],
  ["psql -c 'select 1'", "db", []],
  ["sqlite3 a.db .tables", "db", []],
  ["ssh host uptime", "network", []],
  ["terraform plan", "cloud", []],
  ["gh pr create", "git", []],
  ["kubectl get pods", "container", []],
  ["FOO=bar BAZ=1 bun test", "test", ["test"], "js"],
  ["bun test && bun test", "test", ["test"], "js"],
  ["cd x && git status && npm test", "test", ["test"], "js"],
  ["echo hello", "shell", []],
  ["git commit -m \"fix jest tests\"", "git", []],
  ["git commit -m 'add pytest'", "git", []],
  ["echo \"make sure it passes\"", "shell", []],
  ["grep -r pytest .", "search", []],
  ["cat jest.config.js", "read", []],
  ["echo 'pytest' > x", "write", []],
  ["ls webpack", "read", []],
  ["git log --grep=\"tsc\"", "git", []],
  ["mkdir -p make", "shell", []],
  ["cp make.sh x", "shell", []],
  ["./make.sh", "shell", []],
  ["echo \"a; pytest\"", "shell", []],
  ["python -c \"print('make')\"", "shell", []],
  ["tsc -v", "shell", []],
  ["tsc --help", "shell", []],
  ["make", "build", ["build"], "any"],
  ["make test", "test", ["test"], "any"],
  ["make check", "test", ["test"], "any"],
  ["make lint", "lint", ["lint"], "any"],
  ["make dist", "build", ["build"], "any"],
  ["make install", "shell", []],
  ["npm run typecheck", "typecheck", ["typecheck"], "js"],
  ["npm run type-check", "typecheck", ["typecheck"], "js"],
  ["npm run check", "typecheck", ["typecheck"], "js"],
  ["pnpm lint", "lint", ["lint"], "js"],
  ["bun run lint", "lint", ["lint"], "js"],
  ["bun run typecheck", "typecheck", ["typecheck"], "js"],
  ["yarn lint", "lint", ["lint"], "js"],
  ["npm t", "test", ["test"], "js"],
  ["pnpm -r test", "test", ["test"], "js"],
  ["pnpm --filter web test", "test", ["test"], "js"],
  ["yarn workspace web test", "test", ["test"], "js"],
  ["npm --prefix web test", "test", ["test"], "js"],
  ["bun run --filter web test", "test", ["test"], "js"],
  ["bun run build", "build", ["build"], "js"],
  ["npm run test:unit", "test", ["test"], "js"],
  ["npm install", "package", []],
  ["pnpm add zod", "package", []],
  ["biome ci", "lint", ["lint"], "js"],
  ["next lint", "lint", ["lint"], "js"],
  ["deno lint", "lint", ["lint"], "js"],
  ["deno check mod.ts", "typecheck", ["typecheck"], "js"],
  ["python -m unittest", "test", ["test"], "py"],
  ["python3 -m pytest -x", "test", ["test"], "py"],
  ["black --check .", "lint", ["lint"], "py"],
  ["isort --check .", "lint", ["lint"], "py"],
  ["pre-commit run --all-files", "lint", ["lint"], "any"],
  ["./gradlew check", "test", ["test"], "jvm"],
  ["./gradlew lintDebug", "lint", ["lint"], "jvm"],
  ["./gradlew assembleDebug", "build", ["build"], "jvm"],
  ["./gradlew :app:testDebugUnitTest", "test", ["test"], "jvm"],
  [".\\gradlew.bat test", "test", ["test"], "jvm"],
  ["mvn verify", "test", ["test"], "jvm"],
  ["rake test", "test", ["test"], "ruby"],
  ["php artisan test", "test", ["test"], "php"],
  ["composer test", "test", ["test"], "php"],
  ["phpstan analyse", "typecheck", ["typecheck"], "php"],
  ["dotnet format --verify-no-changes", "lint", ["lint"], "dotnet"],
  ["cargo fmt --check", "lint", ["lint"], "rust"],
  ["rustfmt --check a.rs", "lint", ["lint"], "rust"],
  ["bazel test //...", "test", ["test"], "any"],
  ["flutter test", "test", ["test"], "dart"],
  ["flutter analyze", "lint", ["lint"], "dart"],
  ["dart analyze", "lint", ["lint"], "dart"],
  ["node_modules/.bin/jest", "test", ["test"], "js"],
  ["vue-tsc --noEmit", "typecheck", ["typecheck"], "js"],
  ["go vet ./...", "typecheck", ["typecheck"], "go"],
  ["timeout 60 npm test", "test", ["test"], "js"],
  ["timeout -s KILL 60 npm test", "test", ["test"], "js"],
  ["env CI=1 npm test", "test", ["test"], "js"],
  ["bundle exec rspec", "test", ["test"], "ruby"],
  ["nohup bun test", "test", ["test"], "js"],
  ["pipenv run pytest", "test", ["test"], "py"],
  ["echo hi\nbun test", "test", ["test"], "js"],
  // reading and searching: a category of their own, behind any other category in the same command; checks unaffected
  ["rg -n TODO src", "search", []],
  ["fd -e ts", "search", []],
  ["ag needle", "search", []],
  ["ack needle", "search", []],
  ["find . -name '*.ts'", "search", []],
  ["sudo find / -name x", "search", []],
  ["find . -name '*.log' -delete", "shell", []],
  ["find . -type f -exec rm {} +", "shell", []],
  ["find src -execdir touch {} ;", "shell", []],
  ["head -n 20 README.md", "read", []],
  ["tail -f server.log", "read", []],
  ["wc -l src/a.ts", "read", []],
  ["nl -ba src/a.ts", "read", []],
  ["stat a.ts", "read", []],
  ["tree src", "read", []],
  ["less a.log", "read", []],
  ["more a.log", "read", []],
  ["bat a.ts", "read", []],
  ["cd src && rg needle", "search", []],
  ["cat package.json | grep jest", "read", []],
  ["ls && npm install", "package", []],
  ["git log | head -5", "git", []],
  ["cat a.txt && npm test", "test", ["test"], "js"],
  ["grep -r jest . && pytest", "test", ["test"], "py"],
  ["sed -n 1,80p a.ts", "shell", []],
  // heredoc bodies are data fed to a command, never commands; printing into a file writes it
  ["cat <<EOF > notes.md\nrun make test, then npm test\nEOF", "write", []],
  ["cat <<'EOF' > src/a.ts\nexport const x = 1;\nEOF\nnpm test", "test", ["test"], "js"],
  ["cat << EOF\nmake test\nEOF", "read", []],
  ["cat <<-EOF > Makefile\n\ttest:\n\t\tpytest -q\n\tEOF", "write", []],
  ["python3 - <<'PY'\nimport subprocess\nsubprocess.run(['pytest'])\nPY", "shell", []],
  ["cat <<\"END\" | tee out.txt\npytest\nEND", "write", []],
  ["cat > a.sh <<EOF\nbun test\nEOF\nbash a.sh", "write", []],
  ["cat <<A <<B\nnpm test\nA\ncargo test\nB\nmake lint", "lint", ["lint"], "any"],
  ["cat <<EOF > f\nnpm test", "write", []],
  ["git commit -F - <<EOF\nfix: make tests pass\nEOF", "git", []],
  ["echo \"<<EOF\"\nnpm test", "test", ["test"], "js"],
  ["cat <<< 'pytest'", "read", []],
  ["echo $((1 << 2))", "shell", []],
  ["echo hi > out.txt", "write", []],
  ["printf '%s' x >> log.txt", "write", []],
  ["cat a.txt > b.txt", "write", []],
  ["cat a.txt 1> b.txt", "write", []],
  ["cat a.txt &> b.txt", "write", []],
  ["cat a.txt > /dev/null", "read", []],
  ["cat a.txt 2> err.log", "read", []],
  ["cat a.txt >&2", "read", []],
  ["echo \"a > b\"", "shell", []],
  ["npm test > out.log", "test", ["test"], "js"],
  ["git diff > change.patch", "git", []],
  // a JS package runner (npm, pnpm, yarn, bun; then run, exec or x) followed by a tool the toolchain table names runs it,
  // and a package script named like such a tool is read as that tool
  ["pnpm --filter web vitest run --coverage", "test", ["test"], "js"],
  ["npm exec vitest", "test", ["test"], "js"],
  ["bun x tsc --noEmit", "typecheck", ["typecheck"], "js"],
  ["pnpm tsc --noEmit", "typecheck", ["typecheck"], "js"],
  ["npm run eslint", "lint", ["lint"], "js"],
  // a script reached through run/run-script whose name the script rule already reads keeps that reading; a tool used
  // directly, or through exec or x, keeps the tool's rule
  ["npm run tsc", "typecheck", ["typecheck"], "js"],
  ["npm run-script tsc", "typecheck", ["typecheck"], "js"],
  ["pnpm tsc", "build", ["build"], "js"],
  ["bun x tsc", "build", ["build"], "js"],
  ["npm exec tsc", "build", ["build"], "js"],
  ["npm run make", "build", ["build"], "any"],
  ["yarn workspace web jest --ci", "test", ["test"], "js"],
  ["npm x -- playwright test", "test", ["test"], "js"],
  ["pnpm exec python -m pytest", "test", ["test"], "py"],
  ["yarn npm audit", "shell", []],
  ["npm run dev", "shell", []],
  // wrapper flags that take a value are skipped together with it
  ["env -C web npm test", "test", ["test"], "js"],
  ["env -S x -u FOO pytest", "test", ["test"], "py"],
  ["sudo -g staff -h box -p pw -C 3 make test", "test", ["test"], "any"],
  ["sudo -E -u ci cargo test", "test", ["test"], "rust"],
  ["nice -n 10 go test ./...", "test", ["test"], "go"],
  ["nice -5 npm test", "test", ["test"], "js"],
  ["nice npm run lint", "lint", ["lint"], "js"],
  ["timeout -k 5 60 cargo test", "test", ["test"], "rust"],
  // the toolchain of the command that produced the first check
  ["pytest && npm test", "test", ["test"], "py"],
  ["npm install && pytest", "test", ["test"], "py"],
  ["mix test && npm test", "test", ["test"]],
  // the toolchain table, a tool per row
  ["mocha", "test", ["test"], "js"],
  ["ava", "test", ["test"], "js"],
  ["karma start", "test", ["test"], "js"],
  ["svelte-check", "typecheck", ["typecheck"], "js"],
  ["nuxt build", "build", ["build"], "js"],
  ["astro build", "build", ["build"], "js"],
  ["webpack", "build", ["build"], "js"],
  ["esbuild src/a.ts", "build", ["build"], "js"],
  ["rollup -c", "build", ["build"], "js"],
  ["stylelint '**/*.css'", "lint", ["lint"], "js"],
  ["npx playwright test", "test", ["test"], "js"],
  ["cypress run", "test", ["test"], "js"],
  ["deno test", "test", ["test"], "js"],
  ["py.test", "test", ["test"], "py"],
  ["tox -e py", "test", ["test"], "py"],
  ["nox", "test", ["test"], "py"],
  ["pyright", "typecheck", ["typecheck"], "py"],
  ["flake8 src", "lint", ["lint"], "py"],
  ["pylint src", "lint", ["lint"], "py"],
  ["golangci-lint run", "lint", ["lint"], "go"],
  ["gofmt -l .", "lint", ["lint"], "go"],
  ["gradle build", "build", ["build"], "jvm"],
  ["ktlint", "lint", ["lint"], "jvm"],
  ["dotnet test", "test", ["test"], "dotnet"],
  ["rubocop", "lint", ["lint"], "ruby"],
  ["rspec spec/a_spec.rb", "test", ["test"], "ruby"],
  ["phpunit", "test", ["test"], "php"],
  ["pest", "test", ["test"], "php"],
  ["phpcs src", "lint", ["lint"], "php"],
  ["psalm", "typecheck", ["typecheck"], "php"],
  ["swift test", "test", ["test"], "swift"],
  ["swiftlint", "lint", ["lint"], "swift"],
  ["dart test", "test", ["test"], "dart"],
  ["cmake --build build", "build", ["build"], "native"],
  ["ctest", "test", ["test"], "native"],
  ["shellcheck a.sh", "lint", ["lint"], "shell"],
  ["bazelisk test //...", "test", ["test"], "any"],
  // checks of a command the table names no toolchain for
  ["zig build", "build", ["build"]],
  ["flow check", "typecheck", ["typecheck"]],
];

// a loop, not test.each: test.each hands a missing last column a `done` callback
for (const [cmd, category, checks, toolchain] of rows) {
  test(`classifyCommand(${JSON.stringify(cmd)})`, () => {
    const r = classifyCommand(cmd);
    expect(r).toEqual(toolchain === undefined ? { category, checks } : { category, checks, toolchain });
    expect("toolchain" in r).toBe(toolchain !== undefined); // absent, never undefined
  });
}
test("at least 30 rows", () => expect(rows.length).toBeGreaterThanOrEqual(30));

/**
 * Ordinary check commands the classifier used to read as plain shell: subshells, wrapper flags that take a value, a
 * shell given its script as one string, runners that run the command after them, and runners it had no row for. Each
 * row: the command line and the checks it runs (and the toolchain of the first, when the table names one).
 */
const ordinary: [string, CheckKind[], Toolchain?][] = [
  // a subshell's or a group's closing bracket
  ["(cd web && npm test)", ["test"], "js"], ["(cd x && cargo test)", ["test"], "rust"], ["(cd x && make test)", ["test"], "any"],
  ["(npm test)", ["test"], "js"], ["(cd x && tsc --noEmit)", ["typecheck"], "js"], ["{ npm test; }", ["test"], "js"],
  ["cd web && npm test)", ["test"], "js"], ["(cd api && pytest -q)", ["test"], "py"],
  // wrapper flags that take a value
  ["npx -p typescript tsc --noEmit", ["typecheck"], "js"], ["npx --package typescript tsc --noEmit", ["typecheck"], "js"],
  ["python -u -m pytest", ["test"], "py"], ["python -X dev -m pytest", ["test"], "py"], ["python3 -W error -m unittest", ["test"], "py"],
  ["uv run --with pytest pytest", ["test"], "py"], ["uv run --python 3.12 pytest -q", ["test"], "py"],
  // a shell given its script as one string
  ['bash -lc "npm test"', ["test"], "js"], ["bash -c 'cd app && pytest -q'", ["test"], "py"], ['sh -c "make test"', ["test"], "any"],
  ['zsh -lc "cargo test"', ["test"], "rust"], ["/bin/bash -lc 'npm run lint'", ["lint"], "js"], ['bash -c "tsc --noEmit"', ["typecheck"], "js"],
  ['bash -o pipefail -c "go test ./..."', ["test"], "go"], ["cd x && bash -c 'bun test'", ["test"], "js"],
  ['bash -c "sh -c \\"npm test\\""', ["test"], "js"],
  // runners that run the command after them
  ["pdm run pytest", ["test"], "py"], ["poetry run pytest", ["test"], "py"], ["hatch run pytest", ["test"], "py"],
  ["pipenv run pytest", ["test"], "py"], ["bundle exec rspec", ["test"], "ruby"], ["bundle exec rails test", ["test"], "ruby"],
  ["docker compose exec web npm test", ["test"], "js"], ["docker compose run --rm app pytest", ["test"], "py"],
  ["docker compose exec -T -e CI=1 web npm test", ["test"], "js"], ["docker-compose run app pytest", ["test"], "py"],
  ["docker exec -it api go test ./...", ["test"], "go"], ["docker compose exec app php artisan test", ["test"], "php"],
  // rows of their own
  ["./mvnw test", ["test"], "jvm"], ["mvnw -q verify", ["test"], "jvm"], ["mvnw.cmd test", ["test"], "jvm"], ["./mvnw package", ["build"], "jvm"],
  ["./gradlew test", ["test"], "jvm"], ["gradlew build", ["build"], "jvm"],
  ["python manage.py test", ["test"], "py"], ["python3 manage.py test app", ["test"], "py"],
  ["rails test", ["test"], "ruby"], ["bin/rails test", ["test"], "ruby"],
  ["ng test", ["test"], "js"], ["ng build", ["build"], "js"], ["ng lint", ["lint"], "js"],
  ["cargo nextest run", ["test"], "rust"],
  // script runners follow the rule `npm run <script>` has
  ["turbo run test", ["test"], "js"], ["turbo test", ["test"], "js"], ["turbo run lint build", ["lint", "build"], "js"], ["pnpm turbo run lint", ["lint"], "js"],
  ["npx turbo run build", ["build"], "js"], ["nx test app", ["test"], "js"], ["nx run app:test", ["test"], "js"], ["pnpm nx lint web", ["lint"], "js"],
  ["just test", ["test"], "any"], ["just lint", ["lint"], "any"], ["task test", ["test"], "any"], ["task build", ["build"], "any"],
  ["composer run test", ["test"], "php"], ["composer test", ["test"], "php"], ["composer run-script lint", ["lint"], "php"],
];
const notChecks = [
  "just deploy", "task serve", "turbo run dev", "nx serve app", "composer install", "python manage.py runserver", "rails server", "ng serve",
  "docker compose up", "docker compose exec web sh", "bash -lc 'echo hi'", "python -c \"print('make')\"", "uv run --with pytest python app.py",
];

test("ordinary check commands are read as the checks they run", () => {
  const got = ordinary.map(([c]) => { const r = classifyCommand(c); return [c, r.checks, r.toolchain] as const; });
  expect(got).toEqual(ordinary.map(([c, checks, tc]) => [c, checks, tc] as const));
  expect(notChecks.map((c) => [c, classifyCommand(c).checks])).toEqual(notChecks.map((c) => [c, []]));
  expect(classifyCommand("docker compose up").category).toBe("container");
});

test("a shell's script reads the same given as argv (Codex) and as one string", async () => {
  const { shellScript } = await import("../../../core/text/commands");
  expect(shellScript(["bash", "-lc", "npm test"])).toBe("npm test");
  expect(shellScript(["/bin/zsh", "-c", "make test"])).toBe("make test");
  expect(shellScript(["bash", "-o", "pipefail", "-c", "go test ./..."])).toBe("go test ./...");
  expect(shellScript(["pwsh", "-NoProfile", "-Command", "dotnet test"])).toBe("dotnet test");
  expect(shellScript(["cmd.exe", "/c", "npm test"])).toBe("npm test");
  expect(shellScript(["bash", "script.sh"])).toBeUndefined();
  expect(shellScript(["npm", "-c", "test"])).toBeUndefined();
  for (const argv of [["bash", "-lc", "npm test"], ["sh", "-c", "cd a && pytest -q"]]) {
    const quoted = `${argv.slice(0, -1).join(" ")} '${argv.at(-1)}'`;
    expect(classifyCommand(quoted).checks).toEqual(classifyCommand(shellScript(argv)!).checks);
  }
});
