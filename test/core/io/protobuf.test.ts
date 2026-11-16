import { describe, expect, test } from "bun:test";
import { b64ToBytes, PbError, pbDecode, pbFields, pbTryNested } from "../../../core/io/protobuf";

const u = (...b: number[]) => new Uint8Array(b);

describe("protobuf-lite", () => {
  test("varint", () => {
    expect(pbDecode(u(0x08, 0x96, 0x01))).toEqual([{ no: 1, wire: 0, v: 150n }]);
  });
  test("length-delimited and nested", () => {
    const f = pbDecode(u(0x1a, 0x03, 0x08, 0x96, 0x01));
    expect(f).toHaveLength(1);
    expect(f[0].no).toBe(3);
    expect(f[0].wire).toBe(2);
    const n = pbTryNested(f[0].v as Uint8Array);
    expect(n?.get(1)?.[0].v).toBe(150n);
  });
  test("fixed32 / fixed64", () => {
    expect(pbDecode(u(0x0d, 1, 0, 0, 0))).toEqual([{ no: 1, wire: 5, v: 1 }]);
    expect(pbDecode(u(0x09, 1, 0, 0, 0, 0, 0, 0, 0))).toEqual([{ no: 1, wire: 1, v: 1n }]);
  });
  test("errors", () => {
    expect(() => pbDecode(u(0x08, 0x96))).toThrow(PbError);
    expect(() => pbDecode(u(0x0a, 0x05, 1))).toThrow(PbError);
    expect(() => pbDecode(u(0x0b))).toThrow(PbError); // wire 3
    expect(() => pbDecode(u(0x0c))).toThrow(PbError); // wire 4
    expect(() => pbDecode(u(0x0e))).toThrow(PbError); // wire 6
    expect(() => pbDecode(u(0x0f))).toThrow(PbError); // wire 7
    expect(() => pbDecode(u(0x0d, 1, 0))).toThrow(PbError);
  });
  test("pbTryNested null on garbage / empty", () => {
    expect(pbTryNested(u(0xff, 0xff))).toBeNull();
    expect(pbTryNested(u())).toBeNull();
  });
  test("pbFields groups repeated", () => {
    const m = pbFields(u(0x08, 1, 0x08, 2, 0x10, 3));
    expect(m.get(1)).toHaveLength(2);
    expect(m.get(2)).toHaveLength(1);
  });
  test("b64ToBytes variants", () => {
    const want = [0xfb, 0xff, 0xfe, 0x01];
    for (const s of ["+//+AQ==", "+//+AQ", "-__-AQ==", "-__-AQ"]) expect([...b64ToBytes(s)]).toEqual(want);
  });
});
