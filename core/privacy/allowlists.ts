import type { Analysis } from "../analyze";

/*
 * The allowlists the export reads raw channels through (spec §6.7, global constraints: free text). A raw value leaves
 * the machine only when it is on a list here; anything else becomes a fixed token ("other", "fine-tuned", "custom #n").
 * Pure and synchronous.
 */

/** MCP servers whose names are public (spec §6.7): exported by name; every other server is "custom #n". */
export const MCP_PUBLIC: ReadonlySet<string> = new Set([
  "github", "gitlab", "git", "filesystem", "fetch", "memory", "time", "sequential-thinking", "playwright", "puppeteer", "context7", "sentry",
  "linear", "atlassian", "slack", "postgres", "sqlite", "supabase", "stripe", "cloudflare", "vercel", "docker", "kubernetes", "figma", "brave-search",
]);

/**
 * The public name of an MCP server, or undefined: lower-cased, then "@scope/" and any "server-" or "mcp-" prefix and
 * "-mcp" suffix stripped (repeatedly, so "mcp-server-github" is "github"); a name on `MCP_PUBLIC`, else undefined.
 */
export function mcpExportName(raw: string): string | undefined {
  let s = raw.toLowerCase().replace(/^@[^/]*\//, "");
  for (let was = ""; was !== s;) {
    was = s;
    if (s.startsWith("server-")) s = s.slice("server-".length);
    if (s.startsWith("mcp-")) s = s.slice("mcp-".length);
    if (s.endsWith("-mcp")) s = s.slice(0, -"-mcp".length);
  }
  return MCP_PUBLIC.has(s) ? s : undefined;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The export label of each MCP server of an analysis's private config: keyed hash (`key`) → its public name
 * (`mcpExportName`), else "custom #n", numbered 1, 2, … in keyed-hash order, so the numbering says nothing about the
 * names. Only `mcp-server` entries are labelled. The export's `config.mcpServers` and B's anonymized report both use
 * it (P3 pre-flight F15).
 */
export function mcpLabels(config: Analysis["private"]["config"]): Map<string, string> {
  const out = new Map<string, string>();
  let custom = 0;
  const servers = config.filter((c) => c.kind === "mcp-server").sort((a, b) => cmp(a.key, b.key));
  for (const c of servers) {
    if (out.has(c.key)) continue;
    out.set(c.key, mcpExportName(c.name) ?? `custom #${++custom}`);
  }
  return out;
}

/** A model id from a known vendor family: exported as is. */
export const MODEL_ID = /^(claude|gpt|o\d|gemini|codex|grok|llama|mistral|qwen|deepseek)[a-z0-9.\-]{0,40}$/;

/** A model id as exported: a known family's id as is; a fine-tuned model ("ft:…") as "fine-tuned"; anything else "other". */
export function modelExportId(raw: string): string {
  if (raw.startsWith("ft:")) return "fine-tuned";
  return MODEL_ID.test(raw) ? raw : "other";
}

/**
 * The risk-posture tokens the readers know (their own allowlists map everything else to "other"): Claude Code
 * permission modes, Codex approval policies and sandbox modes. The export keeps these and folds any other into "other".
 */
export const RISK_TOKENS = {
  permission: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
  approval: ["untrusted", "on-failure", "on-request", "granular", "never"],
  sandbox: ["read-only", "workspace-write", "danger-full-access", "external-sandbox", "disabled", "managed"],
} as const satisfies Record<"permission" | "approval" | "sandbox", readonly string[]>;

/** A risk-posture token as exported: a known one, else "other". */
export function riskExportToken(kind: keyof typeof RISK_TOKENS, raw: string): string {
  return (RISK_TOKENS[kind] as readonly string[]).includes(raw) ? raw : "other";
}
