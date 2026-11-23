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
export { analyze, ExclusionError } from "./analyze";
export type { Analysis, AnalyzeOptions } from "./analyze";
export type { Metric, MetricMeta } from "./analysis/types";
export type { DurationArc, Exposure, Feature, PromptArc } from "./analysis/exposure";
export type { ProjectSummary } from "./analysis/labels";
export type { ConfigPanel, CoveragePanel, DayParts, RiskPosture, Stack, StackRole } from "./analysis/panels";
export type { ChildType } from "./analysis/walk";
export type { Evidence, Signals } from "./signals/types";
export type { ComponentResult, Confidence, DimensionId, DimensionResult } from "./scoring/score";
export type { Band, Overall } from "./scoring/overall";
export type { CheckId, CheckResult, CheckStatus, Forensics, ReleaseTable } from "./forensics/index";
// forensic vocabularies, their kinds and the question function: what the reading side of an export needs
export { DATE_KEY, isDay, isValueOf, questionFor, REASONS, VALUE_KEYS, VALUE_KINDS } from "./forensics/index";
export type { CheckValues, ProvenanceKey, Reason, ValueKey, ValueKind } from "./forensics/index";
export { ExportError, RevealError } from "./privacy/export";
export type { ExportStage } from "./privacy/export";
export { exportPayload } from "./privacy/export";
export type { ExportOptions, ExportResult } from "./privacy/export";
export { canonicalJson } from "./privacy/jcs";

// ── Task 16: the final exports. The values Plans 4 and 5b import through `ai-practice-report/core` (P5 pre-flight J5).
// (The export's errors, which a caller of exportPayload catches, are exported with exportPayload above.)
export { buildSessionTable } from "./analysis/sessions";
export type { Exclusions, SessionRow, SessionTable } from "./analysis/types";
export { isAction } from "./analysis/walk";
export { childType } from "./analysis/tiers";
export { modelExportId } from "./privacy/allowlists";
