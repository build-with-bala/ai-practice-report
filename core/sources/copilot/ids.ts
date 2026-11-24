import { sid } from "../../model/ids";
import { idPart, safeModel, UUID } from "../common/guards";
import type { ScanCtx } from "../types";

/** What the Copilot readers share: a reader imports another module of the tool only from here. */
export const TOOL = "copilot";

/** A Copilot session id, `copilot:<id>`: the tool's own id verbatim when UUID-shaped, else its keyed hash. */
export const cpSessionId = (raw: string, ctx: ScanCtx): string => sid(TOOL, idPart(raw, UUID, ctx));

const VENDOR = /^[a-z][a-z0-9-]{0,31}\/(.+)$/;
/** A model id as VS Code records it (`<vendor>/<id>`, e.g. `copilot/<id>`): the vendor prefix dropped, then the shared guard. */
export function cpModel(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : safeModel(VENDOR.exec(raw)?.[1] ?? raw);
}
