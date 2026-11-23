import { describe, expect, test } from "bun:test";
import { AIPROF2, KIND_SPECS, sanitize, violations, type FieldSpec } from "../../../core/privacy/schema";
import { isValueOf, VALUE_KEYS, VALUE_KINDS, type ValueKind } from "../../../core/forensics/types";

/** A field that may be absent. */
const opt = (of: FieldSpec): FieldSpec => ({ t: "optional", of });
/** Every field of the test spec is optional, so each test looks at one field; `required` below covers the default. */
const spec: FieldSpec = {
  t: "object", fields: {
    name: opt({ t: "string", pattern: /^[a-z]{1,8}$/, s: "public" }),
    kind: opt({ t: "enum", values: ["a", "b"], s: "public" }),
    n: opt({ t: "integer", s: "aggregate" }),
    x: opt({ t: "number", s: "aggregate" }),
    ok: opt({ t: "boolean", s: "public" }),
    maybe: opt({ t: "nullable", of: { t: "integer", s: "aggregate" } }),
    list: opt({ t: "array", of: { t: "integer", s: "aggregate" }, max: 3 }),
    counts: opt({ t: "record", key: /^[a-z]{1,4}$/, of: { t: "integer", s: "aggregate" }, maxKeys: 2 }),
    tagged: opt({ t: "record", key: /^[a-z]{1,4}$/, of: { t: "number", s: "aggregate" }, maxKeys: 9, fields: { date: { t: "string", pattern: /^\d{4}-\d{2}-\d{2}$/, s: "aggregate" } } }),
    inner: opt({ t: "object", fields: { a: { t: "integer", s: "aggregate" } } }),
    pair: opt({ t: "nullable", of: { t: "tuple", of: [{ t: "integer", s: "aggregate" }, { t: "integer", s: "aggregate" }] } }),
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

  test("a tuple is all or nothing: one bad element, or a wrong length, fails it whole (I4)", () => {
    expect(sanitize({ pair: [62, 78] }, spec)).toEqual({ pair: [62, 78] });
    expect(sanitize({ pair: null }, spec)).toEqual({ pair: null });
    for (const bad of [[NaN, 78], [62.5, 78], [62, "78"], [62], [62, 78, 90], []]) expect(sanitize({ pair: bad }, spec)).toEqual({});
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

describe("required fields, counts and violations", () => {
  const req: FieldSpec = { t: "object", fields: {
    status: { t: "enum", values: ["scored", "insufficient"], s: "public" },
    score: { t: "nullable", of: { t: "count", s: "aggregate" } },
    name: opt({ t: "string", pattern: /^[a-z]{1,8}$/, s: "revealed" }),
  } };

  test("a required field missing, undefined or not allowed drops the object; null is a value for nullable", () => {
    expect(sanitize({ status: "scored", score: 3 }, req)).toEqual({ status: "scored", score: 3 });
    expect(sanitize({ status: "scored", score: null }, req)).toEqual({ status: "scored", score: null });
    for (const bad of [{ score: 3 }, { status: undefined, score: 3 }, { status: "SCORED", score: 3 }, { status: "scored" }, { status: "scored", score: 71.5 }]) {
      expect(sanitize(bad, req)).toBeUndefined();
    }
  });

  test("an optional field may be absent; when present and not allowed it is left out", () => {
    expect(sanitize({ status: "scored", score: 1, name: "lib" }, req)).toEqual({ status: "scored", score: 1, name: "lib" });
    expect(sanitize({ status: "scored", score: 1, name: undefined }, req)).toEqual({ status: "scored", score: 1 });
    expect(sanitize({ status: "scored", score: 1, name: "Not OK" }, req)).toEqual({ status: "scored", score: 1 });
  });

  test("a bounded number lies in [min, max], ends included", () => {
    const share: FieldSpec = { t: "bounded", min: 0, max: 1, s: "aggregate" };
    for (const ok of [0, 0.5, 1, -0]) expect(sanitize(ok, share)).toBe(ok + 0);
    for (const bad of [-0.0001, 1.0001, NaN, Infinity, "0.5"]) expect(sanitize(bad, share)).toBeUndefined();
    expect(violations({ w: 2 }, { t: "object", fields: { w: share } })).toEqual(["$.w"]);
  });

  test("a count is a non-negative safe integer; an integer may be signed", () => {
    expect(sanitize(0, { t: "count", s: "aggregate" })).toBe(0);
    for (const bad of [-1, 1.5, 2 ** 53, NaN]) expect(sanitize(bad, { t: "count", s: "aggregate" })).toBeUndefined();
    expect(sanitize(-1, { t: "integer", s: "aggregate" })).toBe(-1);
  });

  test("violations names each failing path: missing, wrong form, undeclared; record keys only when they fit their pattern", () => {
    const rec: FieldSpec = { t: "object", fields: { ...((req as Extract<FieldSpec, { t: "object" }>).fields),
      counts: { t: "record", key: /^[a-z]{1,8}$/, of: { t: "count", s: "aggregate" }, maxKeys: 4 },
      pair: { t: "tuple", of: [{ t: "count", s: "aggregate" }, { t: "count", s: "aggregate" }] } } };
    expect(violations({ status: "scored", score: null, counts: {}, pair: [1, 2] }, rec)).toEqual([]);
    expect(violations({ score: -1, name: "Bad Name", counts: { ok: -2, "clients/jdoe acme payroll": 1 }, pair: [1], extra: "x", "/secret/key": 1 }, rec))
      .toEqual(["$.status", "$.score", "$.name", "$.counts.<key>", "$.counts.ok", "$.pair", "$.<key>", "$.<key>"]);
  });

  test("AIPROF2 holds no signed integer: every integer is a count", () => {
    const signed: string[] = [];
    const walk = (s: FieldSpec, at: string): void => {
      if (s.t === "integer") signed.push(at);
      else if (s.t === "optional" || s.t === "nullable" || s.t === "array") walk(s.of, at);
      else if (s.t === "variant") for (const c of Object.values(s.cases)) walk(c, at);
      else if (s.t === "tuple") s.of.forEach((f) => walk(f, at));
      else if (s.t === "object") for (const [k, f] of Object.entries(s.fields)) walk(f, `${at}.${k}`);
      else if (s.t === "record") { walk(s.of, at); for (const f of Object.values(s.fields ?? {})) walk(f, at); }
    };
    walk(AIPROF2, "$");
    expect(signed).toEqual([]);
  });

  test("the optional fields of AIPROF2 are exactly the optional properties of the analysis types", () => {
    const optional: string[] = [];
    const walk = (s: FieldSpec, at: string): void => {
      if (s.t === "optional") { optional.push(at); walk(s.of, at); }
      else if (s.t === "variant") for (const c of Object.values(s.cases)) walk(c, at);
      else if (s.t === "nullable" || s.t === "array") walk(s.of, `${at}[]`);
      else if (s.t === "tuple") s.of.forEach((f, i) => walk(f, `${at}[${i}]`));
      else if (s.t === "object") for (const [k, f] of Object.entries(s.fields)) walk(f, `${at}.${k}`);
      else if (s.t === "record") { walk(s.of, `${at}{}`); for (const [k, f] of Object.entries(s.fields ?? {})) walk(f, `${at}.${k}`); }
    };
    walk(AIPROF2, "$");
    const metric = (p: string) => [`${p}.from`, `${p}.to`, `${p}.reason`];
    const VALUES = "$.forensics.checks[].values.";
    expect(new Set(optional.filter((p) => p.startsWith(VALUES)).map((p) => p.slice(VALUES.length)))).toEqual(new Set(Object.keys(VALUE_KEYS)));
    expect(optional.filter((p) => !p.startsWith(VALUES) && !/^\$\.(signals|exposure\.(tenureWeeks|activeWeeks))\./.test(p)).sort()).toEqual([
      "$.coverage[].from", "$.coverage[].to", // CoveragePanel row from?/to?
      "$.exposure.tools[].from", "$.exposure.tools[].to", // Exposure.tools from?/to?
      "$.projects[].lastWeek", // ProjectSummary.lastWeek?
      "$.projects[].name", // only through reveal
    ].sort());
    expect(optional.filter((p) => p.startsWith("$.signals.vae."))).toEqual(metric("$.signals.vae")); // Metric from?/to?/reason?
  });
});

describe("AIPROF2", () => {
  /** Every leaf spec of a spec, with its path. */
  function leaves(s: FieldSpec, at = "$", out: Array<[string, FieldSpec]> = []): Array<[string, FieldSpec]> {
    switch (s.t) {
      case "optional": return leaves(s.of, at, out);
      case "variant": for (const c of Object.values(s.cases)) leaves(c, at, out); return out;
      case "nullable": case "array": return leaves(s.of, at + "[]", out);
      case "tuple": s.of.forEach((f, i) => leaves(f, `${at}[${i}]`, out)); return out;
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
    if (s.t === "nullable" || s.t === "array" || s.t === "optional") nodes(s.of, out);
    else if (s.t === "tuple") for (const f of s.of) nodes(f, out);
    else if (s.t === "variant") for (const c of Object.values(s.cases)) nodes(c, out);
    else if (s.t === "object") for (const f of Object.values(s.fields)) nodes(f, out);
    else if (s.t === "record") { nodes(s.of, out); for (const f of Object.values(s.fields ?? {})) nodes(f, out); }
    return out;
  }

  test("every leaf declares a sensitivity class", () => {
    for (const [at, s] of leaves(AIPROF2)) {
      expect(`${at} ${"s" in s ? s.s : "?"}`).toMatch(/ (public|aggregate|pseudonymous|revealed)$/);
    }
  });

  /**
   * Valid samples of every pattern in the schema: each pattern must match at least one. A sample with a prefix, a
   * suffix or an embedded newline must then fail it, which an unanchored (or multi-line) pattern would let through.
   */
  const SAMPLES = [
    "1.0.0-dev", "2.13.0", "2026-11", "2026-W47", "2026-11-02", "7/7", "P-3F2A", "my-lib", "0123456789abcdef", "github", "custom #1",
    "claude-opus-4-1-20250805", "gpt-other", "fine-tuned", "other", "restore-cluster", "Was this history restored from a backup then?",
    "matchShare", "claude-code/human/detail", "py", "data", "skill", "default", "never", "read-only", "subagents",
  ];
  const patterns = (): Array<[string, RegExp]> => {
    const out: Array<[string, RegExp]> = [];
    const walk = (s: FieldSpec, at: string): void => {
      if (s.t === "string") out.push([at, s.pattern]);
      else if (s.t === "optional") walk(s.of, at);
      else if (s.t === "variant") for (const c of Object.values(s.cases)) walk(c, at);
      else if (s.t === "nullable" || s.t === "array") walk(s.of, `${at}[]`);
      else if (s.t === "tuple") s.of.forEach((f, i) => walk(f, `${at}[${i}]`));
      else if (s.t === "object") for (const [k, f] of Object.entries(s.fields)) walk(f, `${at}.${k}`);
      else if (s.t === "record") {
        out.push([`${at}{key}`, s.key]);
        walk(s.of, `${at}{}`);
        for (const [k, f] of Object.entries(s.fields ?? {})) walk(f, `${at}.${k}`);
      }
    };
    walk(AIPROF2, "$");
    return out;
  };

  test("every string and key pattern is anchored: a valid sample with a prefix, a suffix or an embedded newline fails", () => {
    const list = patterns();
    expect(list.length).toBeGreaterThan(30);
    for (const [at, re] of list) {
      expect(`${at} m:${re.multiline} g:${re.global} y:${re.sticky}`).toBe(`${at} m:false g:false y:false`);
      const valid = SAMPLES.filter((x) => re.test(x));
      expect(`${at} samples:${valid.length > 0}`).toBe(`${at} samples:true`);
      for (const x of valid) {
        const mid = Math.max(1, x.length >> 1);
        for (const bad of [`\u0000${x}`, `${x}\u0000`, `\n${x}`, `${x}\n`, `${x.slice(0, mid)}\n${x.slice(mid)}`]) {
          expect(`${at} ${JSON.stringify(bad)} ${re.test(bad)}`).toBe(`${at} ${JSON.stringify(bad)} false`);
        }
      }
    }
  });

  test("every array and record is bounded, and every interval is a nullable pair", () => {
    for (const s of nodes(AIPROF2)) {
      if (s.t === "array") expect(s.max).toBeGreaterThan(0);
      if (s.t === "record") expect(s.maxKeys).toBeGreaterThan(0);
      if (s.t === "object" && "interval" in s.fields) {
        const iv = s.fields.interval!; // required: never optional
        expect(iv.t === "nullable" && iv.of.t === "tuple" && iv.of.of.length === 2).toBe(true);
      }
    }
  });

  test("the core version takes semantic versions only", () => {
    const core = (AIPROF2 as Extract<FieldSpec, { t: "object" }>).fields.core as Extract<FieldSpec, { t: "string" }>;
    for (const ok of ["1.0.0", "1.0.0-dev", "10.2.33-rc.1", "1.0.0+build.5"]) expect(`${ok} ${core.pattern.test(ok)}`).toBe(`${ok} true`);
    for (const bad of ["1.0", "01.0.0", "1.0.0-", "1.0.0-dev..x", "v1.0.0", "1.0.0 ", "1.0.0-a b"]) expect(`${bad} ${core.pattern.test(bad)}`).toBe(`${bad} false`);
  });

  test("only `projects[].name` is revealed, and nothing else holds a free-form name", () => {
    expect(leaves(AIPROF2).filter(([, s]) => "s" in s && s.s === "revealed").map(([at]) => at)).toEqual(["$.projects[].name"]);
  });

  test("the schema and questionFor read one kind table: each kind's spec accepts exactly what isValueOf accepts", () => {
    const samples: unknown[] = [0, 1, 2, 0.5, -0, -0.5, -1, -1.0001, 1.0001, 3.7, 1e9, 2 ** 53, -3, NaN, Infinity, -Infinity, "1", null, undefined, {}, [],
      "2026-11-02", "2024-02-29", "2023-02-29", "2026-13-01", "1969-12-31", "2026-11-2", " 2026-11-02", "2026-11-02\n", true];
    for (const kind of ["count", "share", "corr", "ratio", "date"] as ValueKind[]) {
      for (const x of samples) {
        const label = `${kind} ${typeof x === "string" ? JSON.stringify(x) : String(x)}`;
        expect(`${label} ${sanitize(x, KIND_SPECS[kind]) !== undefined}`).toBe(`${label} ${isValueOf(kind, x)}`);
      }
    }
    expect(Object.keys(VALUE_KINDS).sort()).toEqual(Object.keys(VALUE_KEYS).sort());
  });

  test("a check is a variant on its id: closed fields, values closed by kind, the date on C5 only", () => {
    const checks = ((AIPROF2 as Extract<FieldSpec, { t: "object" }>).fields.forensics as Extract<FieldSpec, { t: "object" }>).fields.checks!;
    const ok = { id: "C1", status: "pass", n: 3, reason: "ok", tools: ["claude-code"], values: { rho: 0.5, unrecognized: 0 } };
    expect(violations([ok], checks)).toEqual([]);
    expect(violations([{ ...ok, askAbout: "Why?" }], checks)).toEqual(["$[0].<key>"]);
    expect(violations([{ ...ok, values: { date: "2026-11-02" } }], checks)).toEqual(["$[0].values.<key>"]);
    expect(violations([{ ...ok, id: "C5", values: { date: "2026-11-02", days: 3 } }], checks)).toEqual([]);
    expect(violations([{ ...ok, id: "C5", values: { date: "2026-02-30" } }], checks)).toEqual(["$[0].values.date"]);
    expect(violations([{ ...ok, id: "C42" }, { ...ok, reason: "Free text" }], checks)).toEqual(["$[0].id", "$[1].reason"]);
    expect(sanitize([{ ...ok, id: 5 }], checks)).toEqual([]);
  });

  test("the payload never declares the private, diagnostics or meta parts of an analysis", () => {
    if (AIPROF2.t !== "object") throw new Error("AIPROF2 is an object spec");
    for (const k of ["private", "diagnostics", "meta"]) expect(Object.hasOwn(AIPROF2.fields, k)).toBe(false);
  });
});
