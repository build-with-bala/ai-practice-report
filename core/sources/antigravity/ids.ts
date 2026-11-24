import { sid } from "../../model/ids";
import { idPart, UUID } from "../common/guards";
import type { ScanCtx } from "../types";

/** What the Antigravity readers share: a reader imports another module of the tool only from here. */
export const TOOL = "antigravity";

/** An Antigravity session id, `antigravity:<id>`: the conversation's own id verbatim when UUID-shaped, else its keyed hash. */
export const agSessionId = (raw: string, ctx: ScanCtx): string => sid(TOOL, idPart(raw, UUID, ctx));
