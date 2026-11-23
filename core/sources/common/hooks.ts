import type { CheckKind } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { isObj, type Obj } from "./guards";

/** Hook event names as Claude Code spells them (`PreToolUse`, `Stop`, …); any other key is reported as `other`. */
const HOOK_EVENT = /^[A-Z][A-Za-z]{2,40}$/;
/** Check kinds in one fixed order, so a merged list never depends on the order it was found in. */
const CHECK_ORDER: readonly CheckKind[] = ["test", "build", "lint", "typecheck"];

/**
 * The hooks of a Claude Code settings file (the user's `settings.json` or a repo's `.claude/settings.json`), as kinds
 * and counts. `entries`: the hook entries found (`hooks.<event>[].hooks[]`, each an object). `events` and `entryChecks`:
 * per entry that runs, its event (`other` for a key not shaped like an event name) and — for a command hook — the
 * checks its command runs (`classifyCommand`, in memory: the text is never kept), undefined for any other hook type.
 * `checks`: every entry's checks, merged. `disabled`: `disableAllHooks: true`, so none of them runs — `events`,
 * `entryChecks` and `checks` are then empty, while `entries` still counts what is there.
 */
export interface ParsedHooks { entries: number; events: string[]; entryChecks: (CheckKind[] | undefined)[]; checks: CheckKind[]; disabled: boolean }

/**
 * Parses `settings` for hooks (see ParsedHooks). A field of another type than expected, or a hook list of another
 * shape, is reported by key (`disableAllHooks:type`, `hooks:type`, `hooks:shape`) through `onShape`, and left out.
 */
export function parseHooks(settings: Obj | undefined, onShape: (key: string) => void = () => {}): ParsedHooks {
  const out: ParsedHooks = { entries: 0, events: [], entryChecks: [], checks: [], disabled: false };
  if (settings === undefined) return out;
  const flag = settings.disableAllHooks;
  if (flag !== undefined && flag !== null && typeof flag !== "boolean") onShape("disableAllHooks:type");
  out.disabled = flag === true;
  const table = settings.hooks;
  if (table === undefined || table === null) return out;
  if (!isObj(table)) {
    onShape("hooks:type");
    return out;
  }
  const found = new Set<CheckKind>();
  for (const [event, groups] of Object.entries(table)) {
    const name = HOOK_EVENT.test(event) ? event : "other";
    if (!Array.isArray(groups)) {
      onShape("hooks:shape");
      continue;
    }
    for (const group of groups) {
      const list = isObj(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
      if (!list) {
        onShape("hooks:shape");
        continue;
      }
      for (const hook of list) {
        if (!isObj(hook)) {
          onShape("hooks:shape");
          continue;
        }
        out.entries++;
        if (out.disabled) continue;
        const checks = typeof hook.command === "string" ? classifyCommand(hook.command).checks : undefined;
        out.events.push(name);
        out.entryChecks.push(checks);
        for (const k of checks ?? []) found.add(k);
      }
    }
  }
  out.checks = CHECK_ORDER.filter((k) => found.has(k));
  return out;
}
