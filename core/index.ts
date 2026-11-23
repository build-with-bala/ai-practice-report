import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export { scan } from "./scan";
export type { ScanOptions, ScanResult, Warning } from "./scan";
export { REPO_SIGNALS_DESCRIBE } from "./git/index";
export type { AiTool, CheckFacts, CommitFact, HookFacts, InstructionFacts, InstructionKind, RepoFacts, RepoSignalOptions, RepoSignals } from "./git/index";
export { registry } from "./sources/registry";
export { EventStore } from "./model/store";
export type * from "./model/events";
export type * from "./model/ids";
export { sid } from "./model/ids";
