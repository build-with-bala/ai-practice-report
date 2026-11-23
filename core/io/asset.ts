import { readFileSync } from "node:fs";
import { noteOpen } from "./observe";

/**
 * The bytes of a file the program ships with — a font or a license beside the code, or the same file embedded in a
 * compiled binary (Bun serves those under `/$bunfs/`). The one way core/viz reads a file: reported and screened like
 * every other open (`noteOpen`), then read whole.
 */
export function readAsset(path: string): Uint8Array {
  noteOpen(path, "read");
  const b = readFileSync(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
