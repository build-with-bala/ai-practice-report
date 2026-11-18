import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CANARY, expectNoCanaries } from "./canary";
import { fakeHome, type FakeHome } from "./home";
import { pbEncode } from "./pb";
import { probeJson, probeJsonl, probePbB64, probeSqlite } from "../../scripts/probe";

let home: FakeHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

describe("probe is structure-only", () => {
  test("jsonl/json/sqlite outputs contain no canaries", async () => {
    home = fakeHome();
    const jl = home.writeJsonl("h.jsonl", [
      { type: "user", message: { role: "user", content: CANARY.prompt }, cwd: CANARY.path, n: 3 },
      { type: "user", message: { role: "user", content: [CANARY.code] }, cwd: CANARY.path },
      { type: CANARY.prompt, token: CANARY.token },
      { kind: "assistant", arr: [1, 2, 3], flag: true, nothing: null },
    ]);
    const js = home.writeJson("c.json", { projects: { [CANARY.path]: { mcpServers: { [CANARY.mcp]: { env: { KEY: CANARY.secret } } } } }, email: CANARY.email });
    const db = home.sqlite("s.db", ["CREATE TABLE ItemTable (key TEXT, value BLOB)"], { ItemTable: [[CANARY.host, CANARY.secret]] });
    const out = (await probeJsonl(jl)) + "\n" + probeJson(js) + "\n" + probeSqlite(db);
    expectNoCanaries(out);
    expect(out).toContain("type=user");
    expect(out).toContain("<k×1>");
    expect(out).toContain("ItemTable");
    expect(out).toContain("string(len≤100)");
  });

  test("histogram hides type values that fail the regex", async () => {
    home = fakeHome();
    const jl = home.writeJsonl("h.jsonl", [{ type: CANARY.prompt }]);
    expect(await probeJsonl(jl)).not.toContain("zebra");
  });

  test("max-lines caps the scan", async () => {
    home = fakeHome();
    const jl = home.writeJsonl("h.jsonl", Array.from({ length: 50 }, () => ({ type: "a" })));
    expect(await probeJsonl(jl, 10)).toContain("type=a n=10");
  });

  test("protobuf prints numbers and wire types only", () => {
    const inner = pbEncode([[1, CANARY.secret], [2, 7]]);
    const b64 = Buffer.from(pbEncode([[1, 150], [2, inner], [3, CANARY.prompt]])).toString("base64");
    const out = probePbB64(b64);
    expectNoCanaries(out);
    expect(out).toContain("f1 varint");
    expect(out).toContain("f2 bytes(len≤100)");
    expect(out).toContain("  f1 bytes");
    expect(out).not.toContain("150");
  });

  test("invalid protobuf reports an error without content", () => {
    expect(probePbB64("////")).toContain("not protobuf");
  });
});

describe("probe token filter", () => {
  const bad = [CANARY.secret, CANARY.token, CANARY.mcp, CANARY.project, CANARY.host];
  test("content-like type values and keys never print", async () => {
    home = fakeHome();
    const recs: unknown[] = bad.map((b) => ({ type: b, kind: b, [b]: 1 }));
    recs.push({ type: CANARY.secret }, { type: CANARY.token }); // repeated: still rejected by predicate
    const jl = home.writeJsonl("t.jsonl", recs);
    const js = home.writeJson("t.json", Object.fromEntries(bad.map((b) => [b, { [b]: 1 }])));
    const out = (await probeJsonl(jl)) + "\n" + probeJson(js);
    expectNoCanaries(out);
    expect(out).toContain("type=<other>");
  });
  test("ordinary schema tokens still print", async () => {
    home = fakeHome();
    const jl = home.writeJsonl("t.jsonl", [
      { type: "user", message: {}, sessionId: "x", toolUseResult: 1, $set: 1 },
      { type: "my_event" },
      { type: "my_event" },
      { type: "once_only" },
    ]);
    const out = await probeJsonl(jl);
    for (const t of ["type=user", "type=my_event n=2", "$.message", "$.sessionId", "$.toolUseResult", "$.$set", "[type=my_event]"]) expect(out).toContain(t);
    expect(out).not.toContain("once_only");
  });
});

test("pbEncode round-trips varint/bytes/string", async () => {
  const { pbFields } = await import("../../core/io/protobuf");
  const m = pbFields(pbEncode([[1, 300], [2, "hi"], [3, 5n], [4, new Uint8Array([1, 2])]]));
  expect(m.get(1)![0].v).toBe(300n);
  expect(new TextDecoder().decode(m.get(2)![0].v as Uint8Array)).toBe("hi");
  expect(m.get(3)![0].v).toBe(5n);
});

test("fakeHome paths and sqlite wal", () => {
  const h = fakeHome("win32");
  try {
    expect(h.env.platform).toBe("win32");
    expect(h.env.appData!.startsWith(h.root)).toBe(true);
    expect(h.env.tmp.startsWith(h.root)).toBe(true);
    const p = h.sqlite("a/b/x.db", ["CREATE TABLE t (a INTEGER, b TEXT)"], { t: [[1, "x"], [2, "y"]] }, true);
    const d = new Database(p, { readonly: true }); // a plain path, not a URI
    try {
      expect((d.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(2);
    } finally {
      d.close(); // before cleanup: Windows cannot remove an open file
    }
  } finally {
    h.cleanup();
  }
});
