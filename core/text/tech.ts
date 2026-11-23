import type { TechCategory } from "../model/ids";

/** The terms counted per category: the list the consent preview shows. */
export const TECH_TERMS: Readonly<Record<TechCategory, readonly string[]>> = {
  data: ["database", "migration", "redis", "postgres", "mysql", "mongodb", "sqlite", "index", "transaction", "orm", "schema", "pagination", "backup", "snapshot", "sql injection"],
  infra: ["docker", "kubernetes", "container", "nginx", "proxy", "load balancer", "pipeline", "deploy", "deployment", "rollback", "terraform", "serverless", "s3", "lambda", "port", "subnet", "vpn", "dns", "cron", "queue", "celery", "kafka"],
  security: ["oauth", "jwt", "token", "authentication", "authorization", "encryption", "hash", "ssl", "tls", "cors", "csrf", "xss", "secret", "api key", "firewall", "prompt injection", "environment variable"],
  testing: ["unit test", "integration test", "e2e", "mock", "regression", "linter", "refactor"],
  ai: ["llm", "embedding", "vector", "prompt", "agent", "rag", "model"],
  architecture: ["microservice", "monolith", "endpoint", "rest api", "graphql", "grpc", "webhook", "websocket", "middleware", "dependency", "latency", "throughput", "cache", "caching", "rate limit", "algorithm", "regex", "compiler", "typescript", "rebase", "merge conflict", "closure", "recursion"],
  frontend: ["react", "component", "css", "accessibility"],
  mobile: ["ios", "android", "swift", "kotlin", "flutter"],
  systems: ["race condition", "mutex", "deadlock", "thread", "async", "await", "event loop", "memory leak", "concurrency"],
};

const CATS = Object.keys(TECH_TERMS) as TechCategory[];
const RES = CATS.map((c) => ({
  cat: c,
  re: new RegExp("\\b(" + TECH_TERMS[c].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|") + ")\\b", "gi"),
}));

/** Count of UNIQUE matched terms per category; categories with no match are omitted. */
export function techCategories(text: string): Partial<Record<TechCategory, number>> {
  const out: Partial<Record<TechCategory, number>> = {};
  for (const { cat, re } of RES) {
    const seen = new Set<string>();
    for (const m of text.matchAll(re)) seen.add(m[0].toLowerCase().replace(/\s+/g, " "));
    if (seen.size) out[cat] = seen.size;
  }
  return out;
}
