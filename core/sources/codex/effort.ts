import { oneOf } from "../common/guards";

/** The CLI's reasoning effort levels (ReasoningEffort, 0.169), shared by the rollouts' turns and the thread index. */
export const EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** An effort as the CLI records it: the level when it is one of the CLI's, `other` for any other string, else undefined. */
export const cxEffort = (v: string | undefined): string | undefined => oneOf(v, EFFORTS);
