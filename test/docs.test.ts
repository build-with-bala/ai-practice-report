import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const text = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
/** Every reader's format notes. */
const FORMAT_DOCS = [...new Bun.Glob("core/sources/*/FORMAT.md").scanSync({ cwd: ROOT })].map((f) => f.split(path.sep).join("/")).sort();

interface Line { n: number; line: string }
/** The lines of a text that `keep` accepts, numbered from 1. */
const linesOf = (body: string, keep: (line: string) => boolean): Line[] =>
  body.split(/\r?\n/).map((line, i) => ({ n: i + 1, line })).filter((l) => keep(l.line));

/** A line without its code spans: format constants (field names, `kind:0/1/2`, versions, dates of format changes) live in them. */
const prose = (line: string): string => line.replace(/`[^`]*`/g, "");
/** A figure left in the prose of a `[measured]` line: on the author's machine, so never in the repo. */
const figureOutsideCode = (line: string): boolean => /\d/.test(prose(line));

/** Wording that reports what one machine's records showed, where a format note should state the format. */
const SIGHTINGS = [/was seen/i, /were seen/i, /on most records/i, /on this machine/i, /on this Mac/i];
const reportsSighting = (line: string): boolean => SIGHTINGS.some((re) => re.test(line));

describe("the docs state formats and requirements, never what one machine showed", () => {
  test("design.md: a [measured] line keeps its citation but no figure outside code spans", () => {
    const measured = linesOf(text("docs/design.md"), (line) => line.includes("[measured]"));
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.filter((l) => figureOutsideCode(l.line)).map((l) => `docs/design.md:${l.n}`)).toEqual([]);
  });

  test("FORMAT.md: no line reports what was seen on a machine", () => {
    expect(FORMAT_DOCS).toEqual(expect.arrayContaining(["antigravity", "claude-code", "codex", "copilot", "cursor"].map((t) => `core/sources/${t}/FORMAT.md`)));
    expect(FORMAT_DOCS.flatMap((f) => linesOf(text(f), reportsSighting).map((l) => `${f}:${l.n}`))).toEqual([]);
  });

  test("the checks themselves: a figure outside a code span is flagged, one inside is not; each sighting phrase, in any case", () => {
    expect(figureOutsideCode("recurse subagents (a share of 54 in 100 tool calls [measured])")).toBe(true);
    expect(figureOutsideCode("**Codex** (`P0`) | `state_5.sqlite`, `kind:0` snapshot (`v1` is blind after `2026-02-23` [measured])")).toBe(false);
    const phrases = ["No model field was seen.", "both fields were seen", "it is below the other on most records", "confirmed On This Machine", "as on this mac"];
    expect(phrases.filter((p) => !reportsSighting(p))).toEqual([]);
    expect(reportsSighting("Evidence: confirmed with the structure probe (`scripts/probe.ts`)")).toBe(false);
  });
});
