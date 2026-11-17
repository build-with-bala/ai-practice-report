import { agBrain, agCli, agIde } from "./antigravity";
import { ccConfig, ccHistory, ccStats, ccTranscripts } from "./claude-code";
import { cxConfig, cxHistory, cxRollouts, cxThreads } from "./codex";
import { cpCli, cpJetbrains, cpVscode } from "./copilot";
import { cuAgentCli, cuIde, cuTracking } from "./cursor";
import type { SourcePlugin } from "./types";

/** Tool-reader plugins; each source task appends its plugin(s) here (Tasks 9-15). */
export const registry: SourcePlugin[] = [ccTranscripts, ccHistory, ccStats, ccConfig, cxRollouts, cxThreads, cxHistory, cxConfig, cpVscode, cpCli, cpJetbrains, cuIde,
  cuTracking, cuAgentCli, agCli, agIde, agBrain];
