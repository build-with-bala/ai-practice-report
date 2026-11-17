import type { ScanCtx } from "../types";

/** JSON value guards and string-shape checks shared by the source readers: trace strings never reach an event unchecked. */

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A UUID of any version, as the CLIs name their sessions and threads. */
export const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A tool version string (`2.1.300`, `0.169.0`, `1.2.3-alpha.4`). */
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9.:_[\]-]{0,63}$/;
const EXT = /^[a-z0-9]{1,12}$/;

/** A model id when it has a model id's shape, else `other`. */
export const safeModel = (m: string): string => (MODEL.test(m) ? m : "other");

/** `v` when it is one of `allowed`, `other` for any other string, undefined when absent. */
export const oneOf = (v: string | undefined, allowed: ReadonlySet<string>): string | undefined =>
  v === undefined || allowed.has(v) ? v : "other";

/** A tool's own id verbatim when it has the tool's shape, else its keyed hash (file names and ids can hold anything). */
export const idPart = (name: string, shape: RegExp, ctx: ScanCtx): string => (shape.test(name) ? name : ctx.hash(name));

/** Lower-case extension of a path's last segment (1–12 letters or digits); dotfiles and names without one have none. */
export function extOfPath(p: string): string | undefined {
  const base = p.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT.test(ext) ? ext : undefined;
}
