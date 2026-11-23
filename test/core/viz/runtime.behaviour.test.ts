import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { KIT_RUNTIME } from "../../../core/viz/runtime";

/*
 * The runtime run against a tiny fake DOM. The script text is written into a temporary ES module, as the body of its
 * default export, and loaded with a dynamic import(): nothing builds code from a string. The fake DOM holds just the
 * elements, attributes, selectors and events the runtime touches. Selectors: comma lists of `tag`, `[attr]`,
 * `[attr="v"]`, `.class` and `:not([attr])` compounds.
 */

type Runtime = (document: unknown, window: unknown, navigator: unknown, Element: unknown) => void;
let dir = "";
let run: Runtime;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "kit-runtime-"));
  const file = path.join(dir, "runtime.mjs");
  writeFileSync(file, `export default function (document, window, navigator, Element) {\n${KIT_RUNTIME}\n}\n`);
  run = (await import(pathToFileURL(file).href)).default as Runtime;
});

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

class FakeClassList {
  private readonly set = new Set<string>();
  add(c: string): void { this.set.add(c); }
  remove(c: string): void { this.set.delete(c); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  parent: FakeElement | null = null;
  scrollLeft = 0;
  scrollWidth = 100;
  constructor(readonly tag: string) {}
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, String(v)); }
  removeAttribute(n: string): void { this.attrs.delete(n); }
  get open(): boolean { return this.attrs.has("open"); }
  set open(v: boolean) { if (v) this.attrs.set("open", ""); else this.attrs.delete("open"); }
  append(...els: FakeElement[]): this {
    for (const e of els) { e.parent = this; this.children.push(e); }
    return this;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((sel) => {
      const m = sel.trim().match(/^([a-z]*)(.*)$/)!;
      if (m[1] !== "" && m[1] !== this.tag) return false;
      for (const part of m[2]!.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]|\.([\w-]+)|:not\(\[([\w-]+)\]\)/g)) {
        if (part[1] !== undefined && (!this.attrs.has(part[1]) || (part[2] !== undefined && this.attrs.get(part[1]) !== part[2]))) return false;
        if (part[3] !== undefined && !this.classList.contains(part[3])) return false;
        if (part[4] !== undefined && this.attrs.has(part[4])) return false;
      }
      return true;
    });
  }
  closest(selector: string): FakeElement | null {
    for (let e: FakeElement | null = this; e !== null; e = e.parent) if (e.matches(selector)) return e;
    return null;
  }
  *all(): Generator<FakeElement> {
    for (const c of this.children) { yield c; yield* c.all(); }
  }
}

type Handler = (e: Record<string, unknown>) => void;

class Target {
  readonly handlers = new Map<string, Handler[]>();
  addEventListener(type: string, h: Handler): void { this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]); }
  fire(type: string, e: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...e };
    for (const h of this.handlers.get(type) ?? []) h(ev);
    return ev;
  }
}

/**
 * A page with a theme toggle, two cite buttons, a link that carries data-cite, two exhibits, two closed details and one
 * closed details under `[data-print="skip"]`. A key press on a button is followed by the click the browser makes of it.
 */
function boot(o: { saved?: string; prefersLight?: boolean } = {}) {
  const html = new FakeElement("html");
  html.setAttribute("data-theme", "auto");
  const el = (tag: string, attrs: Record<string, string> = {}): FakeElement => {
    const e = new FakeElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const toggle = el("button", { type: "button", "data-kit-theme": "", "aria-pressed": "false" });
  const citeC = el("button", { type: "button", class: "cite", "data-cite": "ex-c", "aria-pressed": "false" });
  const citeD = el("button", { type: "button", class: "cite", "data-cite": "ex-d", "aria-pressed": "false" });
  const label = el("span");
  citeC.append(label);
  const link = el("a", { href: "#ex-c", "data-cite": "ex-c" });
  const exC = el("figure", { id: "ex-c" });
  const exD = el("figure", { id: "ex-d" });
  const d1 = el("details");
  const d2 = el("details");
  const dSkip = el("details");
  const skip = el("div", { "data-print": "skip" }).append(dSkip);
  html.append(el("body").append(toggle, citeC, citeD, link, exC, exD, d1, d2, skip));

  const doc = new Target() as Target & Record<string, unknown>;
  doc.documentElement = html;
  doc.querySelectorAll = (s: string) => [...html.all()].filter((e) => e.matches(s));
  doc.getElementById = (id: string) => [...html.all()].find((e) => e.getAttribute("id") === id) ?? null;
  const store = new Map<string, string>(o.saved === undefined ? [] : [["kit-theme", o.saved]]);
  const win = new Target() as Target & Record<string, unknown>;
  win.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  win.matchMedia = () => ({ matches: o.prefersLight === true, addEventListener() {} });
  let prints = 0;
  win.print = () => { prints++; };
  run(doc, win, { userAgent: "Fake/1.0" }, FakeElement);

  const click = (t: FakeElement) => doc.fire("click", { target: t });
  /** A key press on a button: the runtime sees the keydown, then the browser's own click of the button. */
  const press = (t: FakeElement, key: string) => {
    const ev = doc.fire("keydown", { target: t, key });
    if (!ev.defaultPrevented && t.tag === "button" && (key === "Enter" || key === " ")) click(t);
    return ev;
  };
  return { html, toggle, citeC, citeD, label, link, exC, exD, d1, d2, dSkip, doc, win, store, click, press, prints: () => prints };
}

describe("KIT_RUNTIME behaviour: cites", () => {
  test("a click pins a cite: aria-pressed true and the cited exhibit is-cited; a second click releases both", () => {
    const p = boot();
    p.click(p.label);
    expect([p.citeC.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual(["true", true]);
    p.click(p.citeC);
    expect([p.citeC.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual(["false", false]);
  });

  test("pinning another cite releases the first", () => {
    const p = boot();
    p.click(p.citeC);
    p.click(p.citeD);
    expect([p.citeC.getAttribute("aria-pressed"), p.citeD.getAttribute("aria-pressed")]).toEqual(["false", "true"]);
    expect([p.exC.classList.contains("is-cited"), p.exD.classList.contains("is-cited")]).toEqual([false, true]);
  });

  test("Enter and Space arrive as the button's click, so each press toggles exactly once", () => {
    const p = boot();
    p.press(p.citeC, "Enter");
    expect([p.citeC.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual(["true", true]);
    p.press(p.citeC, " ");
    expect([p.citeC.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual(["false", false]);
  });

  test("focus marks the cited exhibit and blur unmarks it, unless it is pinned", () => {
    const p = boot();
    p.doc.fire("focusin", { target: p.citeC });
    expect(p.exC.classList.contains("is-cited")).toBe(true);
    p.doc.fire("focusout", { target: p.citeC });
    expect(p.exC.classList.contains("is-cited")).toBe(false);
    p.click(p.citeC);
    p.doc.fire("mouseout", { target: p.citeC });
    expect(p.exC.classList.contains("is-cited")).toBe(true);
  });

  test("a link carrying data-cite is not a cite: it never gets aria-pressed", () => {
    const p = boot();
    p.click(p.link);
    p.press(p.link, "Enter");
    expect([p.link.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual([null, false]);
  });
});

describe("KIT_RUNTIME behaviour: theme", () => {
  test("the toggle switches ink and paper, keeps the choice and syncs aria-pressed", () => {
    const p = boot();
    expect(p.toggle.getAttribute("aria-pressed")).toBe("false");
    p.click(p.toggle);
    expect([p.html.getAttribute("data-theme"), p.toggle.getAttribute("aria-pressed"), p.store.get("kit-theme")]).toEqual(["paper", "true", "paper"]);
    p.click(p.toggle);
    expect([p.html.getAttribute("data-theme"), p.toggle.getAttribute("aria-pressed"), p.store.get("kit-theme")]).toEqual(["ink", "false", "ink"]);
  });

  test("a saved choice is applied on load; with none, a light preference reads as paper", () => {
    expect(boot({ saved: "paper" }).html.getAttribute("data-theme")).toBe("paper");
    const light = boot({ prefersLight: true });
    expect([light.html.getAttribute("data-theme"), light.toggle.getAttribute("aria-pressed")]).toEqual(["auto", "true"]);
    light.click(light.toggle);
    expect(light.html.getAttribute("data-theme")).toBe("ink");
  });

  test("the print button opens the print dialog", () => {
    const p = boot();
    const btn = new FakeElement("button");
    btn.setAttribute("data-kit-print", "");
    p.html.children[0]!.append(btn);
    p.click(btn);
    expect(p.prints()).toBe(1);
  });
});

describe("KIT_RUNTIME behaviour: print", () => {
  test("beforeprint opens closed details outside data-print=skip and shows paper; afterprint restores both", () => {
    const p = boot();
    p.win.fire("beforeprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open, p.dSkip.open]).toEqual(["paper", true, true, false]);
    expect(p.html.classList.contains("no-margin-boxes")).toBe(true);
    p.win.fire("afterprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open]).toEqual(["auto", false, false]);
    expect(p.html.classList.contains("no-margin-boxes")).toBe(false);
  });

  test("a details the reader had open stays open after the print", () => {
    const p = boot();
    p.d1.open = true;
    p.win.fire("beforeprint");
    p.win.fire("afterprint");
    expect([p.d1.open, p.d2.open]).toEqual([true, false]);
  });

  test("a lost afterprint is recovered on the next beforeprint, which prints with paper and open details again", () => {
    const p = boot();
    p.win.fire("beforeprint"); // its afterprint never fires
    p.click(p.toggle); // the reader picks ink while paper still shows
    expect(p.html.getAttribute("data-theme")).toBe("ink");
    p.d2.open = false;
    p.win.fire("beforeprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open]).toEqual(["paper", true, true]);
    p.win.fire("afterprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open]).toEqual(["ink", false, false]);
  });

  test("two beforeprints with no change between them restore the theme from before the first", () => {
    const p = boot();
    p.win.fire("beforeprint");
    p.win.fire("beforeprint");
    p.win.fire("afterprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open]).toEqual(["auto", false]);
  });
});
