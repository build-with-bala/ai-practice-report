import { describe, expect, test } from "bun:test";
import { cite } from "../../../core/viz/html";
import { KIT_RUNTIME } from "../../../core/viz/runtime";

/*
 * The runtime run against a tiny fake DOM: just the elements, attributes, selectors and events the runtime touches.
 * Selectors: comma lists of `tag`, `[attr]`, `[attr="v"]`, `.class` and `:not([attr])` compounds.
 */

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

/** A page with a theme toggle, two cite buttons, a link that carries data-cite, two exhibits and two closed details. */
function boot() {
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
  html.append(el("body").append(toggle, citeC, citeD, link, exC, exD, d1, d2));

  const doc = new Target() as Target & Record<string, unknown>;
  doc.documentElement = html;
  doc.querySelectorAll = (s: string) => [...html.all()].filter((e) => e.matches(s));
  doc.getElementById = (id: string) => [...html.all()].find((e) => e.getAttribute("id") === id) ?? null;
  const store = new Map<string, string>();
  const win = new Target() as Target & Record<string, unknown>;
  win.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  win.print = () => {};
  const nav = { userAgent: "Fake/1.0" };
  new Function("document", "window", "navigator", "Element", KIT_RUNTIME)(doc, win, nav, FakeElement);

  const click = (t: FakeElement) => doc.fire("click", { target: t });
  const key = (t: FakeElement, k: string) => doc.fire("keydown", { target: t, key: k });
  return { html, toggle, citeC, citeD, label, link, exC, exD, d1, d2, doc, win, click, key };
}

describe("KIT_RUNTIME: cites", () => {
  test("the canonical cite is the button cite() renders", () => {
    expect(cite("ex-c", "Ex. C")).toBe('<button type="button" class="cite" data-cite="ex-c" aria-pressed="false">Ex. C</button>');
  });

  test("a click pins a cite button (aria-pressed true, the exhibit cited); a second click releases it", () => {
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

  test("keyboard: Enter or Space on a button is the button's own click, so the runtime toggles exactly once", () => {
    const p = boot();
    for (const k of ["Enter", " "]) {
      const before = p.citeC.getAttribute("aria-pressed");
      const ev = p.key(p.citeC, k);
      expect([k, ev.defaultPrevented, p.citeC.getAttribute("aria-pressed")]).toEqual([k, false, before]);
      p.click(p.citeC); // what the browser does next
      expect([k, p.citeC.getAttribute("aria-pressed")]).toEqual([k, before === "true" ? "false" : "true"]);
    }
  });

  test("focus marks the cited exhibit and blur unmarks it, unless it is pinned", () => {
    const p = boot();
    p.doc.fire("focusin", { target: p.citeC });
    expect(p.exC.classList.contains("is-cited")).toBe(true);
    p.doc.fire("focusout", { target: p.citeC });
    expect(p.exC.classList.contains("is-cited")).toBe(false);
  });

  test("a link carrying data-cite is not a cite: it never gets aria-pressed, by click or by Enter", () => {
    const p = boot();
    p.click(p.link);
    p.key(p.link, "Enter");
    expect([p.link.getAttribute("aria-pressed"), p.exC.classList.contains("is-cited")]).toEqual([null, false]);
  });
});

describe("KIT_RUNTIME: print", () => {
  test("beforeprint opens closed details and shows paper; afterprint restores both", () => {
    const p = boot();
    p.win.fire("beforeprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open]).toEqual(["paper", true, true]);
    p.win.fire("afterprint");
    expect([p.html.getAttribute("data-theme"), p.d1.open, p.d2.open]).toEqual(["auto", false, false]);
  });

  test("a lost afterprint does not latch the guard: the next beforeprint prints with paper and open details again", () => {
    const p = boot();
    p.win.fire("beforeprint"); // its afterprint never fires
    p.click(p.toggle); // the reader picks ink
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
