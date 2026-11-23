/**
 * The kit's page script: ES2020, a classic script (no modules), shipped inline and pinned by the page's CSP hash.
 *
 * - **Theme:** a `<button data-kit-theme aria-pressed>` switches between ink and paper; `aria-pressed` is true while the
 *   paper theme shows (chosen or by `prefers-color-scheme`). The choice is kept in `localStorage`, inside try/catch.
 * - **Print:** a `<button data-kit-print>` opens the print dialog. `beforeprint` opens every closed `<details>` outside
 *   `[data-print="skip"]`, switches to the paper theme (the print tokens then apply through `@media print`) and adds
 *   `no-margin-boxes` to `<html>` unless the browser is Chromium 131 or later; `afterprint` restores all three.
 * - **Cites:** hovering or focusing a `[data-cite="<id>"]` gives the element with that id `is-cited`; a tap, a click or
 *   Enter pins it (`aria-pressed="true"` on the cite) until the cite is activated again or another is pinned.
 * - **Scroll boxes:** every `.scroll-x[data-scroll="end"]` scrolls to its end on load.
 *
 * It makes no requests, builds no code from strings and writes no HTML.
 */
export const KIT_RUNTIME: string = String.raw`(function () {
"use strict";
var doc = document, root = doc.documentElement, KEY = "kit-theme";
function saved() { try { return window.localStorage.getItem(KEY); } catch (e) { return null; } }
function save(v) { try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the choice lasts for this view */ } }
var light = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
function current() {
  var t = root.getAttribute("data-theme");
  if (t === "ink" || t === "paper") return t;
  return light && light.matches ? "paper" : "ink";
}
function sync() {
  var paper = current() === "paper" ? "true" : "false";
  doc.querySelectorAll("[data-kit-theme]").forEach(function (b) { b.setAttribute("aria-pressed", paper); });
}
var s = saved();
if (s === "ink" || s === "paper") root.setAttribute("data-theme", s);
sync();
if (light) {
  if (light.addEventListener) light.addEventListener("change", sync); else if (light.addListener) light.addListener(sync);
}

var pinned = null;
function targetOf(c) { var id = c.getAttribute("data-cite"); return id ? doc.getElementById(id) : null; }
function mark(c, on) { var t = targetOf(c); if (t) t.classList.toggle("is-cited", on); }
function release() { if (pinned) { pinned.setAttribute("aria-pressed", "false"); mark(pinned, false); pinned = null; } }
function pin(c) {
  if (pinned === c) { release(); return; }
  release();
  pinned = c;
  c.setAttribute("aria-pressed", "true");
  mark(c, true);
}
function citeOf(e) { return e.target instanceof Element ? e.target.closest("[data-cite]") : null; }
function hover(e, on) {
  var c = citeOf(e);
  if (!c) return;
  if (!on && pinned && targetOf(pinned) === targetOf(c)) return;
  mark(c, on);
}
doc.addEventListener("mouseover", function (e) { hover(e, true); });
doc.addEventListener("mouseout", function (e) { hover(e, false); });
doc.addEventListener("focusin", function (e) { hover(e, true); });
doc.addEventListener("focusout", function (e) { hover(e, false); });
doc.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var c = citeOf(e);
  // A link or a button already turns Enter into a click.
  if (c && !c.closest("a[href],button")) { e.preventDefault(); pin(c); }
});
doc.addEventListener("click", function (e) {
  var t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest("[data-kit-theme]")) {
    var next = current() === "paper" ? "ink" : "paper";
    root.setAttribute("data-theme", next);
    save(next);
    sync();
    return;
  }
  if (t.closest("[data-kit-print]")) { window.print(); return; }
  var c = t.closest("[data-cite]");
  if (c) pin(c);
});

function chromium131() {
  var ua = navigator.userAgentData, brands = ua && ua.brands;
  if (brands) for (var i = 0; i < brands.length; i++) if (brands[i].brand === "Chromium") return Number(brands[i].version) >= 131;
  var m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  return m !== null && Number(m[1]) >= 131;
}
var printing = false, opened = [], themeBefore = null;
window.addEventListener("beforeprint", function () {
  if (printing) return;
  printing = true;
  opened = [];
  doc.querySelectorAll("details:not([open])").forEach(function (d) {
    if (d.closest('[data-print="skip"]')) return;
    d.open = true;
    opened.push(d);
  });
  themeBefore = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "paper");
  if (!chromium131()) root.classList.add("no-margin-boxes");
});
window.addEventListener("afterprint", function () {
  if (!printing) return;
  printing = false;
  opened.forEach(function (d) { d.open = false; });
  opened = [];
  if (themeBefore === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", themeBefore);
  root.classList.remove("no-margin-boxes");
  sync();
});

function toEnd() { doc.querySelectorAll('.scroll-x[data-scroll="end"]').forEach(function (el) { el.scrollLeft = el.scrollWidth; }); }
toEnd();
window.addEventListener("load", toEnd);
})();`;
