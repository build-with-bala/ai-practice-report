function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/** Test-only protobuf encoder: number/bigint -> varint, Uint8Array/string -> length-delimited. */
export function pbEncode(fields: Array<[no: number, value: number | bigint | Uint8Array | string]>): Uint8Array {
  const out: number[] = [];
  for (const [no, value] of fields) {
    if (typeof value === "number" || typeof value === "bigint") {
      out.push(...varint(BigInt(no) << 3n), ...varint(BigInt(value)));
    } else {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      out.push(...varint((BigInt(no) << 3n) | 2n), ...varint(BigInt(bytes.length)));
      for (const b of bytes) out.push(b);
    }
  }
  return new Uint8Array(out);
}
