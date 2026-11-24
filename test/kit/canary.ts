export const CANARY = {
  email: "canary.person@example-corp.test",
  host: "canary-host-7731.local",
  secret: "sk-canary-0000SECRET0000",
  token: "gho_canaryToken000000000000000000000000",
  path: "/Users/canaryuser/clients/AcmeSecretProject",
  project: "AcmeSecretProject",
  prompt: "CANARY_PROMPT the zebra eats seventeen lanterns",
  code: "function canarySecretFn() { return 42 }",
  mcp: "acme-internal-mcp",
  /** Token-shaped like a schema name, so only an allowlist (never a shape guard) keeps it out. */
  slug: "quill-harbor-ops",
} as const;

export type CanaryKey = keyof typeof CANARY;
const KEYS = Object.keys(CANARY) as CanaryKey[];
const dec = new TextDecoder();

/**
 * The fields that hold a tool's own strings raw by design (global constraints): the raw config names `ConfigEv.name` and
 * `ToolEv.mcpServer`, and the model ids `SessionEv.models`, `TurnEv.model`, `UsageEv.model` (allowlisted at export).
 * Their strings are collected apart, so that an allowed canary may sit there and nowhere else.
 */
const isExempt = (owner: object, key: string): boolean => {
  const k = (owner as { k?: unknown }).k;
  return (k === "config" && key === "name") || (k === "tool" && key === "mcpServer") || (k === "session" && key === "models")
    || ((k === "turn" || k === "usage") && key === "model");
};

function collect(value: unknown, out: string[], seen: WeakSet<object>, exempt: string[] = out): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (typeof value === "function") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
    out.push(dec.decode(new Uint8Array(value)));
    return;
  }
  if (ArrayBuffer.isView(value)) {
    out.push(dec.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
    return;
  }
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? "");
    collect((value as { cause?: unknown }).cause, out, seen, exempt);
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collect(k, out, seen, exempt);
      collect(v, out, seen, exempt);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const v of value) collect(v, out, seen, exempt);
  }
  for (const k of Reflect.ownKeys(value)) {
    if (typeof k === "symbol") out.push(k.description ?? "");
    else out.push(k);
    let v: unknown;
    try {
      v = (value as Record<string | symbol, unknown>)[k];
    } catch {
      continue; // throwing getter
    }
    if (typeof k === "string" && isExempt(value, k)) collect(v, exempt, seen, exempt);
    else collect(v, out, seen, exempt);
  }
  // class getters on the prototype chain
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== Error.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Reflect.ownKeys(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, k);
      if (!d?.get) continue;
      try {
        collect(d.get.call(value), out, seen, exempt);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Canary keys whose value occurs as an exact substring anywhere in `value` (keys included). An `allow`ed canary may
 * occur in the exempt fields (`ConfigEv.name`, `ToolEv.mcpServer`) only: anywhere else it is still a hit.
 */
export function findCanaries(value: unknown, o: { allow?: CanaryKey[] } = {}): string[] {
  const strings: string[] = [];
  const exempt: string[] = [];
  collect(value, strings, new WeakSet(), exempt);
  const allow = new Set<string>(o.allow ?? []);
  const hit = (k: CanaryKey, list: string[]) => list.some((s) => s.includes(CANARY[k]));
  return KEYS.filter((k) => hit(k, strings) || (!allow.has(k) && hit(k, exempt)));
}

export function expectNoCanaries(value: unknown, o: { allow?: CanaryKey[] } = {}): void {
  const hits = findCanaries(value, o);
  if (hits.length) throw new Error(`canary leaked: ${hits.join(", ")}`);
}
