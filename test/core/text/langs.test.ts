import { describe, expect, test } from "bun:test";
import type { Toolchain } from "../../../core/model/ids";
import { langOfExt, toolchainMatches, type EditLang } from "../../../core/text/langs";

describe("langOfExt", () => {
  test("the brief's cases", () => {
    expect(langOfExt("tsx")).toBe("js");
    expect(langOfExt("md")).toBe("doc");
    expect(langOfExt("sql")).toBe("any");
    expect(langOfExt(undefined)).toBeUndefined();
  });

  const table: [EditLang, string][] = [
    ["js", "ts tsx js jsx mjs cjs vue svelte astro css scss sass less html"],
    ["py", "py pyi ipynb"],
    ["go", "go"],
    ["rust", "rs"],
    ["jvm", "java kt kts scala groovy clj"],
    ["dotnet", "cs fs vb"],
    ["ruby", "rb erb"],
    ["php", "php"],
    ["swift", "swift m mm"],
    ["dart", "dart"],
    ["native", "c h cc cpp cxx hpp hh"],
    ["shell", "sh bash zsh fish ps1"],
    ["doc", "md mdx txt rst adoc json jsonc yaml yml toml ini cfg csv tsv lock svg png jpg jpeg gif webp ico pdf"],
  ];
  for (const [lang, exts] of table) {
    test(`${lang}: ${exts}`, () => expect(exts.split(" ").map((e) => [e, langOfExt(e)])).toEqual(exts.split(" ").map((e) => [e, lang])));
  }

  test("any other extension is code of no listed toolchain; case does not matter; no extension has no language", () => {
    expect(["sql", "proto", "lua", "zig", "ex", "tf", "r", "graphql"].map((e) => langOfExt(e))).toEqual(Array(8).fill("any"));
    expect([langOfExt("TSX"), langOfExt("Md"), langOfExt("PY")]).toEqual(["js", "doc", "py"]);
    expect(langOfExt("")).toBeUndefined();
  });
});

describe("toolchainMatches", () => {
  const set = (...t: Toolchain[]) => new Set<Toolchain>(t);
  test("the brief's cases", () => {
    expect(toolchainMatches("py", set("js"))).toBe(false);
    expect(toolchainMatches(undefined, set("py"))).toBe(true);
    expect(toolchainMatches("js", set("any"))).toBe(true);
  });
  test("a check of no known toolchain, or of `any`, matches any edit; else the edited toolchains must hold it", () => {
    expect(toolchainMatches("any", set("py"))).toBe(true);
    expect(toolchainMatches("js", set("py", "js"))).toBe(true);
    expect(toolchainMatches("go", set("py", "js"))).toBe(false);
    expect(toolchainMatches("go", set())).toBe(false);
    expect(toolchainMatches(undefined, set())).toBe(true);
  });
});
