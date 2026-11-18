import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ccSid, iso, slug } from "../fixtures/claude-code";

const CHILD = path.join(import.meta.dir, "..", "kit", "scan-child.ts");
/** Four transcripts of typed prompts: a full scan takes seconds, far longer than the 200 ms after which the signal comes. */
const FILES = 4;
const PROMPTS = 30_000;

let root: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "scan-signals-test-"));
  home = path.join(root, "home");
  const dir = path.join(home, ".claude", "projects", slug("/work/signals"));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 2 * 86_400_000;
  for (let f = 0; f < FILES; f++) {
    const id = ccSid(`G${f}`);
    const lines: string[] = [];
    for (let i = 0; i < PROMPTS; i++) {
      lines.push(JSON.stringify({
        type: "user", sessionId: id, timestamp: iso(t0 + i * 1_000), cwd: "/work/signals", version: "2.1.300", entrypoint: "cli",
        promptSource: "typed", turnOrigin: "human", message: { role: "user", content: `Fix the failing importer test ${i} and rerun the suite` },
      }));
    }
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `sinceSignal`: ms from the last signal sent to the child's exit. */
interface Run { code: number; signal: string | number | null; out: string; sinceSignal: number; leftovers: string[] }
type Mode = "default" | "owned" | "tail" | "overlap" | "overlap-listener" | "stubborn";

/**
 * Runs the child (test/kit/scan-child.ts) in its own TMPDIR; once it prints `ready`, waits `after` ms (200 by default)
 * and sends `sig`, and with `again`, sends it a second time `again` ms later.
 */
async function runChild(mode: Mode, sig: "SIGINT" | "SIGTERM", o: { after?: number; again?: number } = {}): Promise<Run> {
  const tmp = mkdtempSync(path.join(root, "tmp-"));
  const child = Bun.spawn([process.execPath, CHILD, home, tmp, mode], { stdout: "pipe", stderr: "ignore", env: { ...process.env, TMPDIR: tmp } });
  let out = "";
  let sentAt = Number.NaN;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = () => {
    sentAt = performance.now();
    child.kill(sig);
  };
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true });
      if (timers.length === 0 && out.includes("ready")) {
        timers.push(setTimeout(() => {
          send();
          if (o.again !== undefined) timers.push(setTimeout(send, o.again));
        }, o.after ?? 200));
      }
    }
  })();
  const code = await child.exited;
  await reading;
  for (const t of timers) clearTimeout(t);
  return { code, signal: child.signalCode, out, sinceSignal: performance.now() - sentAt, leftovers: readdirSync(tmp).filter((n) => n.startsWith("aipr-")) };
}

// Windows has no POSIX signals: a child cannot be sent a SIGINT its handlers would see, so these run on macOS and Linux.
describe.skipIf(process.platform === "win32")("a signal during a scan (child process)", () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    test(`${sig} mid-scan: the child ends promptly by that signal, nothing after scan() runs, no aipr-* folder is left`, async () => {
      const r = await runChild("default", sig);
      expect(r.out).toContain("ready");
      expect(r.out).toContain("copied"); // the scan had made its temp folder when the signal came
      expect(r.out).not.toContain("after-scan");
      expect(r.code).not.toBe(0);
      expect(r.signal).toBe(sig);
      expect(r.sinceSignal).toBeLessThan(1_500);
      expect(r.leftovers).toEqual([]);
    }, 30_000);
  }

  test("handleSignals false: the application's own SIGINT handler aborts; scan() cleans up and resolves with aborted coverage", async () => {
    const r = await runChild("owned", "SIGINT");
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("after-scan "));
    expect(line).toBeDefined();
    const got = JSON.parse(line!.slice("after-scan ".length)) as { status: string; note: string; records: number; tempClean: boolean };
    expect(got).toMatchObject({ status: "error", note: "aborted", tempClean: true });
    expect(got.records).toBeLessThan(FILES * PROMPTS); // stopped part-way
    expect(r.sinceSignal).toBeLessThan(1_500);
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a SIGINT during the last job's synchronous work, after its last await: the child ends by it, nothing after scan() runs, no aipr-* is left", async () => {
    const r = await runChild("tail", "SIGINT", { after: 300 });
    expect(r.out).toContain("copied");
    expect(r.out).not.toContain("after-scan");
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("two scans at once and one SIGINT: the child ends by it once both have cleaned up, and neither scan's caller goes on", async () => {
    const r = await runChild("overlap", "SIGINT", { after: 300 });
    expect(r.out).toContain("copied A");
    expect(r.out).toContain("copied B");
    expect(r.out).not.toContain("after-scan A");
    expect(r.out).not.toContain("after-scan B");
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("two scans at once while the application keeps a SIGINT listener of its own: the re-raise goes to it, and both scans resolve with aborted coverage", async () => {
    const r = await runChild("overlap-listener", "SIGINT", { after: 300 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("app-listener");
    for (const name of ["A", "B"]) {
      const line = r.out.split("\n").find((l) => l.startsWith(`after-scan ${name} `));
      expect([name, line === undefined ? undefined : JSON.parse(line.slice(`after-scan ${name} `.length))])
        .toEqual([name, { status: "error", note: "aborted", tempClean: true }]);
    }
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a second SIGINT while a plugin ignores the abort: the child ends by it at once, its temp files removed first", async () => {
    const r = await runChild("stubborn", "SIGINT", { after: 300, again: 200 });
    expect(r.out).toContain("copied");
    expect(r.out).not.toContain("after-scan");
    expect(r.signal).toBe("SIGINT");
    expect(r.sinceSignal).toBeLessThan(500);
    expect(r.leftovers).toEqual([]);
  }, 30_000);
});
