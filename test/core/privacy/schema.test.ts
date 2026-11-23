import { describe, expect, test } from "bun:test";
import { AIPROF2, sanitize, type FieldSpec } from "../../../core/privacy/schema";

const spec: FieldSpec = {
  t: "object", fields: {
    name: { t: "string", pattern: /^[a-z]{1,8}$/, s: "public" },
    kind: { t: "enum", values: ["a", "b"], s: "public" },
    n: { t: "integer", s: "aggregate" },
    x: { t: "number", s: "aggregate" },
    ok: { t: "boolean", s: "public" },
    maybe: { t: "nullable", of: { t: "integer", s: "aggregate" } },
    list: { t: "array", of: { t: "integer", s: "aggregate" }, max: 3 },
    counts: { t: "record", key: /^[a-z]{1,4}$/, of: { t: "integer", s: "aggregate" }, maxKeys: 2 },
    tagged: { t: "record", key: /^[a-z]{1,4}$/, of: { t: "number", s: "aggregate" }, maxKeys: 9, fields: { date: { t: "string", pattern: /^\d{4}-\d{2}-\d{2}$/, s: "aggregate" } } },
    inner: { t: "object", fields: { a: { t: "integer", s: "aggregate" } } },
  },
};

describe("sanitize: deny by default", () => {
  test("drops an undeclared key, at the top and inside", () => {
    expect(sanitize({ name: "ok", extra: "secret", inner: { a: 1, b: 2 } }, spec)).toEqual({ name: "ok", inner: { a: 1 } });
  });

  test("drops a string failing its pattern and a value out of its enum", () => {
    expect(sanitize({ name: "Not OK!", kind: "c" }, spec)).toEqual({});
    expect(sanitize({ name: "fine", kind: "b" }, spec)).toEqual({ name: "fine", kind: "b" });
  });

  test("drops a value of the wrong type: non-finite numbers, fractions for integers, strings for numbers", () => {
    expect(sanitize({ n: 1.5, x: NaN, ok: "true", maybe: "1" }, spec)).toEqual({});
    expect(sanitize({ n: 2, x: Infinity }, spec)).toEqual({ n: 2 });
    expect(sanitize({ x: -0 }, spec)).toEqual({ x: 0 });
    expect(Object.is((sanitize({ x: -0 }, spec) as { x: number }).x, 0)).toBe(true);
  });

  test("nullable keeps null and a valid value", () => {
    expect(sanitize({ maybe: null }, spec)).toEqual({ maybe: null });
    expect(sanitize({ maybe: 3 }, spec)).toEqual({ maybe: 3 });
  });

  test("truncates an array to max, dropping invalid elements", () => {
    expect(sanitize({ list: [1, 2, 3, 4, 5] }, spec)).toEqual({ list: [1, 2, 3] });
    expect(sanitize({ list: [1, "x", 2] }, spec)).toEqual({ list: [1, 2] });
    expect(sanitize({ list: "1,2" }, spec)).toEqual({});
  });

  test("a record keeps keys matching its pattern, at most maxKeys (in key order); declared keys take their own spec", () => {
    expect(sanitize({ counts: { c: 3, a: 1, "B!": 9, b: 2 } }, spec)).toEqual({ counts: { a: 1, b: 2 } });
    expect(sanitize({ tagged: { date: "2026-01-02", n: 1, other: "2026-01-02" } }, spec)).toEqual({ tagged: { date: "2026-01-02", n: 1 } });
    expect(sanitize({ tagged: { date: 5 } }, spec)).toEqual({ tagged: {} });
  });

  test("an object spec takes only plain objects: arrays, null and class instances drop", () => {
    expect(sanitize({ inner: [1] }, spec)).toEqual({});
    expect(sanitize({ inner: null }, spec)).toEqual({});
    expect(sanitize(new Map([["name", "x"]]), spec)).toBeUndefined();
  });

  test("an object with another prototype is dropped, and __proto__ never becomes a key", () => {
    expect(sanitize(Object.create({ name: "inherit" }), spec)).toBeUndefined();
    expect(sanitize(Object.assign(Object.create(null), { name: "ok" }), spec)).toEqual({ name: "ok" });
    const out = sanitize(JSON.parse('{"counts":{"__proto__":{"a":1},"a":1}}'), spec) as { counts: object };
    expect(Object.getPrototypeOf(out.counts)).toBe(Object.prototype);
    expect(Object.keys(out.counts)).toEqual(["a"]);
  });
});

describe("AIPROF2", () => {
  /** Every leaf spec of a spec, with its path. */
  function leaves(s: FieldSpec, at = "$", out: Array<[string, FieldSpec]> = []): Array<[string, FieldSpec]> {
    switch (s.t) {
      case "nullable": case "array": return leaves(s.of, at + "[]", out);
      case "object": for (const [k, f] of Object.entries(s.fields)) leaves(f, `${at}.${k}`, out); return out;
      case "record":
        leaves(s.of, `${at}{}`, out);
        for (const [k, f] of Object.entries(s.fields ?? {})) leaves(f, `${at}.${k}`, out);
        return out;
      default: out.push([at, s]); return out;
    }
  }
  /** Every spec node of a spec. */
  function nodes(s: FieldSpec, out: FieldSpec[] = []): FieldSpec[] {
    out.push(s);
    if (s.t === "nullable" || s.t === "array") nodes(s.of, out);
    else if (s.t === "object") for (const f of Object.values(s.fields)) nodes(f, out);
    else if (s.t === "record") { nodes(s.of, out); for (const f of Object.values(s.fields ?? {})) nodes(f, out); }
    return out;
  }

  test("every leaf declares a sensitivity class", () => {
    for (const [at, s] of leaves(AIPROF2)) {
      expect(`${at} ${"s" in s ? s.s : "?"}`).toMatch(/ (public|aggregate|pseudonymous|revealed)$/);
    }
  });

  test("every pattern is anchored at both ends and stateless; every array and record is bounded", () => {
    for (const s of nodes(AIPROF2)) {
      const res = s.t === "string" ? [s.pattern] : s.t === "record" ? [s.key] : [];
      for (const re of res) {
        expect(`${re.source} ${re.source.startsWith("^") && re.source.endsWith("$")}`).toBe(`${re.source} true`);
        expect(re.global || re.sticky).toBe(false);
      }
      if (s.t === "array") expect(s.max).toBeGreaterThan(0);
      if (s.t === "record") expect(s.maxKeys).toBeGreaterThan(0);
    }
  });

  test("only `projects[].name` is revealed, and nothing else holds a free-form name", () => {
    expect(leaves(AIPROF2).filter(([, s]) => "s" in s && s.s === "revealed").map(([at]) => at)).toEqual(["$.projects[].name"]);
  });

  test("the payload never declares the private, diagnostics or meta parts of an analysis", () => {
    if (AIPROF2.t !== "object") throw new Error("AIPROF2 is an object spec");
    for (const k of ["private", "diagnostics", "meta"]) expect(Object.hasOwn(AIPROF2.fields, k)).toBe(false);
  });
});
