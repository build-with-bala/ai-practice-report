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
    collect((value as { cause?: unknown }).cause, out, seen);
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collect(k, out, seen);
      collect(v, out, seen);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const v of value) collect(v, out, seen);
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
    collect(v, out, seen);
  }
  // class getters on the prototype chain
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== Error.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Reflect.ownKeys(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, k);
      if (!d?.get) continue;
      try {
        collect(d.get.call(value), out, seen);
      } catch {
        /* ignore */
      }
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
