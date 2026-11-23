import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../core/privacy/jcs";

describe("canonicalJson (RFC 8785)", () => {
  test("keys sorted, no whitespace, strings as JSON", () => {
    expect(canonicalJson({ b: 1, a: [1, "é"] })).toBe('{"a":[1,"é"],"b":1}');
  });

  test("keys sort by UTF-16 code units, not by code point or locale", () => {
    // U+10000 is the pair D800 DC00, which sorts before U+E000 by code unit (but after it by code point)
    const k1 = "\u{10000}";
    const k2 = "";
    expect(canonicalJson({ [k2]: 2, [k1]: 1, B: 0, a: 0 })).toBe(`{"B":0,"a":0,"${k1}":1,"${k2}":2}`);
  });

  test("numbers in ECMAScript form: -0 is 0, exponents as Number#toString writes them", () => {
    expect(canonicalJson([-0, 1e21, 1e-7, 0.1, 100, 333333333.3333333])).toBe("[0,1e+21,1e-7,0.1,100,333333333.3333333]");
  });

  test("escapes: the short forms and lower-case \\u00xx for other controls; everything else raw", () => {
    expect(canonicalJson("\b\t\n\f\r\"\\\u0001\u001f/€")).toBe('"\\b\\t\\n\\f\\r\\"\\\\\\u0001\\u001f/€"');
  });

  test("non-finite numbers throw", () => {
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson([-Infinity])).toThrow();
  });

  test("a lone surrogate throws, in a string and in a key; a valid pair is unchanged (P4 pre-flight G6)", () => {
    expect(() => canonicalJson(String.fromCharCode(0xd800))).toThrow();
    expect(() => canonicalJson(`a${String.fromCharCode(0xdc00)}b`)).toThrow();
    expect(() => canonicalJson({ [String.fromCharCode(0xd800)]: 1 })).toThrow();
    const pair = String.fromCodePoint(0x1f600);
    expect(canonicalJson(pair)).toBe(`"${pair}"`);
    expect(canonicalJson({ [pair]: pair })).toBe(`{"${pair}":"${pair}"}`);
  });

  test("only JSON data: undefined, functions, bigints, symbols and class instances throw", () => {
    for (const v of [undefined, () => 1, 1n, Symbol("s"), new Date(0), new Map(), { a: undefined }]) expect(() => canonicalJson(v)).toThrow();
    expect(canonicalJson({ n: null, t: true, f: false, e: [], o: {} })).toBe('{"e":[],"f":false,"n":null,"o":{},"t":true}');
  });

  test("its output parses back to the same data", () => {
    const v = { z: [1, { y: "x", a: null }], "": 0.5 };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });
});
