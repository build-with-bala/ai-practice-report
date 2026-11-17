/** A version-7 UUID (RFC 9562): its first 48 bits are the creation time in Unix milliseconds. */
const V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Creation time (epoch ms) embedded in a version-7 UUID; undefined for any other string. */
export function uuidV7Ms(uuid: string): number | undefined {
  const m = V7.exec(uuid);
  return m ? Number.parseInt(m[1]! + m[2]!, 16) : undefined;
}
