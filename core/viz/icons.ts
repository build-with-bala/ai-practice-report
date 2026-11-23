import { attr } from "./html";

/** The kit's glyphs that the embedded font subsets lack, drawn as SVG (builder's call 3). */
export type IconName = "arrow" | "flag" | "check" | "diamond" | "diamond-hollow" | "triangle" | "dot" | "ring" | "square" | "theme" | "print";

/** Path data on a 12×12 grid; `evenodd` marks the shapes with a hole. Every icon fills with `currentColor` (class `icon`). */
const PATHS: Readonly<Record<IconName, { d: string; evenodd?: true }>> = {
  arrow: { d: "M1 5h6V2.5L11 6 7 9.5V7H1z" },
  flag: { d: "M2 1h1.2v10H2zM3.2 1.5H10L8 4l2 2.5H3.2z" },
  check: { d: "M1 6.5l1.4-1.4 2.4 2.4 4.8-4.8L11 4.1l-6.2 6.2z" },
  diamond: { d: "M6 1l5 5-5 5-5-5z" },
  "diamond-hollow": { d: "M6 1l5 5-5 5-5-5zM6 3.1L3.1 6 6 8.9 8.9 6z", evenodd: true },
  triangle: { d: "M2 1.5L10.5 6 2 10.5z" },
  dot: { d: "M6 3a3 3 0 1 1 0 6 3 3 0 1 1 0-6z" },
  ring: { d: "M6 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 1 1 0-9zM6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6z", evenodd: true },
  square: { d: "M2 2h8v8H2z" },
  theme: { d: "M6 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 1 1 0-9zM6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM6 3a3 3 0 0 0 0 6z", evenodd: true },
  print: { d: "M3 1h6v3H3zM1 4.5h10V9H9.5V7h-7v2H1zM3 7.5h6V11H3z" },
};

/** A 12×12 inline SVG icon of class `icon`: hidden from assistive technology, or an image named by `label`. */
export function icon(name: IconName, o: { label?: string } = {}): string {
  const p = PATHS[name];
  const a11y = o.label === undefined ? ' aria-hidden="true"' : ` role="img"${attr("aria-label", o.label)}`;
  return `<svg class="icon" viewBox="0 0 12 12" width="12" height="12"${a11y} focusable="false"><path d="${p.d}"${p.evenodd ? ' fill-rule="evenodd"' : ""}/></svg>`;
}
