// Fetches the pinned fonts and their licenses (core/viz/fonts/manifest.ts) into core/viz/fonts/. Dev time only, once:
// the files are committed, and CI never fetches. Every file is checked against its pinned size and SHA-256 (and a font
// against the wOF2 magic) before anything is written: one mismatch and nothing is written.
//   bun scripts/fonts-fetch.ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FONT_FILES, LICENSE_FILES } from "../core/viz/fonts/manifest";

const WOFF2_MAGIC = "wOF2";

export async function fetchFonts(o: { dir: string; fetch?: typeof fetch }): Promise<{ written: string[] }> {
  const get = o.fetch ?? fetch;
  const pinned = [...FONT_FILES.map((f) => ({ ...f, font: true })), ...LICENSE_FILES.map((l) => ({ ...l, font: false }))];
  const fetched: { file: string; bytes: Uint8Array }[] = [];
  for (const p of pinned) {
    const res = await get(p.url);
    if (!res.ok) throw new Error(`${p.file}: HTTP ${res.status} from ${p.url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== p.bytes) throw new Error(`${p.file}: ${bytes.length} bytes, pinned ${p.bytes}: the upstream file changed`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== p.sha256) throw new Error(`${p.file}: SHA-256 ${sha}, pinned ${p.sha256}: the upstream file changed`);
    if (p.font && new TextDecoder().decode(bytes.subarray(0, 4)) !== WOFF2_MAGIC) throw new Error(`${p.file}: not a WOFF2 file`);
    fetched.push({ file: p.file, bytes });
  }
  mkdirSync(o.dir, { recursive: true });
  const written: string[] = [];
  for (const f of fetched) {
    const to = path.join(o.dir, f.file);
    writeFileSync(to, f.bytes);
    written.push(to);
  }
  return { written };
}

if (import.meta.main) {
  const { written } = await fetchFonts({ dir: path.join(import.meta.dir, "..", "core", "viz", "fonts") });
  for (const w of written) console.log(`wrote ${path.basename(w)}`);
}
