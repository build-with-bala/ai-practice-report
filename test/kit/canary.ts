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
} as const;

export type CanaryKey = keyof typeof CANARY;
const KEYS = Object.keys(CANARY) as CanaryKey[];
const dec = new TextDecoder();

function collect(value: unknown, out: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (value instanceof Uint8Array) {
    out.push(dec.decode(value));
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collect(k, out, seen);
      collect(v, out, seen);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const v of value) collect(v, out, seen);
  } else {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collect(v, out, seen);
    }
  }
}

/** Canary keys whose value occurs as an exact substring anywhere in `value` (keys included). */
export function findCanaries(value: unknown, o: { allow?: CanaryKey[] } = {}): string[] {
  const strings: string[] = [];
  collect(value, strings, new WeakSet());
  const allow = new Set<string>(o.allow ?? []);
  return KEYS.filter((k) => !allow.has(k) && strings.some((s) => s.includes(CANARY[k])));
}

export function expectNoCanaries(value: unknown, o: { allow?: CanaryKey[] } = {}): void {
  const hits = findCanaries(value, o);
  if (hits.length) throw new Error(`canary leaked: ${hits.join(", ")}`);
}
