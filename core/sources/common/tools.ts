import type { ToolEv } from "../../model/events";
import type { CheckKind } from "../../model/ids";

const CHECK_CATEGORIES: ReadonlySet<string> = new Set<CheckKind>(["test", "build", "lint", "typecheck"]);

/**
 * The event contract's check invariant: a call whose category is a check (test, build, lint, typecheck) lists that
 * check in `checks`, first. The orchestrator applies it to every tool event a plugin emits, so a reader that maps a
 * typed test step to category `test` cannot leave the check out. Returns the same event.
 */
export function withCheckCategory(ev: ToolEv): ToolEv {
  if (CHECK_CATEGORIES.has(ev.category) && !ev.checks?.includes(ev.category as CheckKind)) {
    ev.checks = [ev.category as CheckKind, ...(ev.checks ?? [])];
  }
  return ev;
}
