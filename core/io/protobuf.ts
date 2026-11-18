// Minimal protobuf wire-format reader (no schema). Wire types 0, 1, 2, 5 only.
export type PbField =
  | { no: number; wire: 0 | 1; v: bigint }
  | { no: number; wire: 2; v: Uint8Array }
  | { no: number; wire: 5; v: number };

export class PbError extends Error {}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new PbError("truncated varint");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new PbError("varint too long");
}

export function pbDecode(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (no < 1) throw new PbError("bad field number");
    if (wire === 0) {
      let v: bigint;
      [v, pos] = readVarint(buf, pos);
      out.push({ no, wire: 0, v });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new PbError("truncated fixed64");
      out.push({ no, wire: 1, v: dv.getBigUint64(pos, true) });
      pos += 8;
    } else if (wire === 2) {
      let len: bigint;
      [len, pos] = readVarint(buf, pos);
      if (len > BigInt(buf.length - pos)) throw new PbError("length beyond buffer");
      const n = Number(len);
      out.push({ no, wire: 2, v: buf.subarray(pos, pos + n) });
      pos += n;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new PbError("truncated fixed32");
      out.push({ no, wire: 5, v: dv.getUint32(pos, true) });
      pos += 4;
    } else {
      throw new PbError(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

export function pbFields(buf: Uint8Array): Map<number, PbField[]> {
  const m = new Map<number, PbField[]>();
  for (const f of pbDecode(buf)) {
    const l = m.get(f.no);
    if (l) l.push(f);
    else m.set(f.no, [f]);
  }
  return m;
}

export function pbTryNested(bytes: Uint8Array): Map<number, PbField[]> | null {
  if (bytes.length === 0) return null;
  try {
    return pbFields(bytes);
  } catch {
    return null;
  }
}

export function b64ToBytes(s: string): Uint8Array {
  const std = s.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}
