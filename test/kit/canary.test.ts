import { describe, expect, test } from "bun:test";
import { CANARY, expectNoCanaries, findCanaries } from "./canary";

describe("canary harness", () => {
  test("finds a canary nested in arrays/objects/Maps", () => {
    expect(findCanaries({ a: [{ b: new Map([["x", CANARY.email]]) }] })).toEqual(["email"]);
  });
  test("finds canaries in keys, Set values, Map keys and bytes", () => {
    const hits = findCanaries({ [CANARY.mcp]: 1, s: new Set([CANARY.token]), m: new Map([[CANARY.host, 1]]), u: new TextEncoder().encode(CANARY.secret) });
    expect(hits.sort()).toEqual(["host", "mcp", "secret", "token"]);
  });
  test("substring hits count; clean values do not", () => {
    expect(findCanaries(`prefix ${CANARY.code} suffix`)).toEqual(["code"]);
    expect(findCanaries({ n: 42, ok: true, s: "nothing here", z: null })).toEqual([]);
  });
  test("allow covers the two exempt fields only: ConfigEv.name and ToolEv.mcpServer", () => {
    expectNoCanaries([{ k: "config", name: CANARY.mcp }, { k: "tool", mcpServer: CANARY.slug }], { allow: ["mcp", "slug"] });
    // the same value anywhere else is still a hit, allowed or not
    expect(findCanaries({ k: "config", name: CANARY.mcp, kind: CANARY.mcp }, { allow: ["mcp"] })).toEqual(["mcp"]);
    expect(findCanaries({ k: "tool", name: CANARY.slug }, { allow: ["slug"] })).toEqual(["slug"]);
    expect(findCanaries({ k: "session", name: CANARY.mcp }, { allow: ["mcp"] })).toEqual(["mcp"]);
    expect(findCanaries({ name: CANARY.mcp }, { allow: ["mcp"] })).toEqual(["mcp"]);
    expect(findCanaries(new Map([[CANARY.slug, { k: "config", name: CANARY.slug }]]), { allow: ["slug"] })).toEqual(["slug"]); // a Map key
    expect(findCanaries({ unknownTypes: { [`event:${CANARY.slug}`]: 1 } }, { allow: ["slug"] })).toEqual(["slug"]); // a drift key
    // not allowed: a hit in an exempt field too
    expect(findCanaries({ k: "config", name: CANARY.mcp })).toEqual(["mcp"]);
  });
  test("handles cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(findCanaries(a)).toEqual([]);
  });
  test("Error message, stack and nested cause", () => {
    expect(findCanaries(new Error(CANARY.secret))).toEqual(["secret"]);
    expect(findCanaries({ e: new Error("x", { cause: new Error(CANARY.token) }) })).toEqual(["token"]);
  });
  test("DataView, ArrayBuffer and non-Uint8 typed arrays", () => {
    const bytes = new TextEncoder().encode(CANARY.email);
    expect(findCanaries(new DataView(bytes.buffer.slice(0) as ArrayBuffer))).toEqual(["email"]);
    expect(findCanaries(bytes.buffer.slice(0))).toEqual(["email"]);
    const u16 = new Uint16Array(new TextEncoder().encode(CANARY.host + "\0\0").buffer.slice(0) as ArrayBuffer);
    expect(findCanaries(u16)).toEqual(["host"]);
  });
  test("symbol keys, symbol descriptions and class getters", () => {
    expect(findCanaries({ [Symbol(CANARY.mcp)]: 1 })).toEqual(["mcp"]);
    expect(findCanaries({ [Symbol("k")]: CANARY.code })).toEqual(["code"]);
    class G { get secretThing() { return CANARY.token; } }
    expect(findCanaries(new G())).toEqual(["token"]);
  });
});
