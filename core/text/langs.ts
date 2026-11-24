import type { Toolchain } from "../model/ids";

/** The language of an edited file: a toolchain's code, or `doc` — prose, data, configuration, lock files and images. */
export type EditLang = Toolchain | "doc";

/**
 * Extensions by language; any extension not listed is code of no listed toolchain (`any`). Plain `html` and `css` are
 * `any` on purpose: templates and styles of any stack (Django, Rails, PHP, Go), so a test of that stack verifies them.
 */
const EXTENSIONS: Readonly<Record<EditLang, string>> = {
  js: "ts tsx js jsx mjs cjs vue svelte astro scss sass less",
  py: "py pyi ipynb",
  go: "go",
  rust: "rs",
  jvm: "java kt kts scala groovy clj",
  dotnet: "cs fs vb",
  ruby: "rb erb",
  php: "php",
  swift: "swift m mm",
  dart: "dart",
  native: "c h cc cpp cxx hpp hh",
  shell: "sh bash zsh fish ps1",
  doc: "md mdx txt rst adoc json jsonc yaml yml toml ini cfg csv tsv lock svg png jpg jpeg gif webp ico pdf",
  any: "",
};
const LANG_OF: ReadonlyMap<string, EditLang> = new Map(
  (Object.entries(EXTENSIONS) as [EditLang, string][]).flatMap(([lang, exts]) => exts.split(" ").filter(Boolean).map((e) => [e, lang] as const)),
);

/** The language of a file extension (`ToolEv.editExt`); undefined without an extension, `any` for an unlisted one. */
export function langOfExt(ext: string | undefined): EditLang | undefined {
  if (!ext) return undefined;
  return LANG_OF.get(ext.toLowerCase()) ?? "any";
}

/**
 * Whether a check verifies edits of the given toolchains: a check of no known toolchain, or of `any`, verifies any edit;
 * so does any check when an edit is of `any`; otherwise the edited toolchains must include the check's.
 */
export function toolchainMatches(check: Toolchain | undefined, edited: ReadonlySet<Toolchain>): boolean {
  return check === undefined || check === "any" || edited.has("any") || edited.has(check);
}
