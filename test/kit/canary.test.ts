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
  test("allow exempts keys", () => {
    expectNoCanaries({ name: CANARY.mcp }, { allow: ["mcp"] });
    expect(() => expectNoCanaries({ name: CANARY.mcp })).toThrow();
  });
  test("handles cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(findCanaries(a)).toEqual([]);
  });
});
