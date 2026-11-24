import { normalizePath } from "../../text/hash";
import type { ScanCtx } from "../types";

/**
 * The project key of a folder, without registering it for repo signals: the key `ctx.registerCwd` gives the same folder
 * (both are the keyed hash of the normalized path), so a prompt or a config entry of a folder carries the key its
 * sessions carry. Only a session's cwd is registered: repo signals are read only for repos found from sessions.
 */
export const projectKeyOf = (ctx: ScanCtx, cwd: string): string => ctx.hash(normalizePath(cwd));
