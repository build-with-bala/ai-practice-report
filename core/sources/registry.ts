import { ccConfig, ccHistory, ccStats, ccTranscripts } from "./claude-code";
import type { SourcePlugin } from "./types";

/** Tool-reader plugins; each source task appends its plugin(s) here (Tasks 9-15). */
export const registry: SourcePlugin[] = [ccTranscripts, ccHistory, ccStats, ccConfig];
