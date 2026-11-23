import { describe, expect, test } from "bun:test";
import { cite } from "../../../core/viz/html";
import { KIT_RUNTIME } from "../../../core/viz/runtime";

/*
 * Source checks on the runtime's cite and print handling. The script itself is never executed here: running a string
 * as code is exactly what the repository's push guard refuses, so behaviour is pinned through the source's shape.
 */

describe("KIT_RUNTIME: cites", () => {
  test("the canonical cite is the button cite() renders", () => {
    expect(cite("ex-c", "Ex. C")).toBe('<button type="button" class="cite" data-cite="ex-c" aria-pressed="false">Ex. C</button>');
  });

  test("only button[data-cite] is a cite: a link carrying data-cite never gets aria-pressed", () => {
    expect(KIT_RUNTIME).toContain('var CITE = "button[data-cite]";');
    expect(KIT_RUNTIME).not.toContain('closest("[data-cite]")');
    expect(KIT_RUNTIME.match(/closest\(CITE\)/g)?.length).toBe(2);
  });

  test("the keyboard is the button's own click: no keydown handler that could toggle a second time", () => {
    expect(KIT_RUNTIME).not.toContain("keydown");
    expect(KIT_RUNTIME).toContain('setAttribute("aria-pressed", "true")');
    expect(KIT_RUNTIME).toContain('setAttribute("aria-pressed", "false")');
  });
});

describe("KIT_RUNTIME: print", () => {
  test("a lost afterprint does not latch the guard: the next beforeprint restores the stale print first", () => {
    expect(KIT_RUNTIME).not.toMatch(/if \(printing\) return/);
    expect(KIT_RUNTIME).toContain("if (printing) restore();");
    expect(KIT_RUNTIME).toContain('window.addEventListener("afterprint", function () { if (printing) restore(); });');
  });

  test("restore keeps a theme the reader picked while a lost print showed paper", () => {
    expect(KIT_RUNTIME).toContain('if (root.getAttribute("data-theme") === "paper") {');
  });
});
