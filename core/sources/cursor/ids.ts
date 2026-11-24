import { sid } from "../../model/ids";
import { idPart, UUID } from "../common/guards";
import type { ScanCtx } from "../types";

/** What the Cursor readers share: a reader imports another module of the tool only from here. */
export const TOOL = "cursor";
export const IDE_SOURCE = "cursor.ide";

/** A Cursor session id, `cursor:<id>`: the composer's own id verbatim when UUID-shaped, else its keyed hash. */
export const cuSessionId = (raw: string, ctx: ScanCtx): string => sid(TOOL, idPart(raw, UUID, ctx));
