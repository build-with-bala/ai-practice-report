/**
 * How a core/io primitive opens a file's content: `stream` (read in chunks: JSONL, text lines), `read` (read whole: a
 * small JSON file), `sqlite` (opened by SQLite), `header` (a store's first bytes, which say its journal mode) or `copy`
 * (copied into a private temp folder: a busy store).
 */
export type OpenHow = "stream" | "read" | "sqlite" | "header" | "copy";

let observer: ((path: string, how: OpenHow) => void) | undefined;

/**
 * Says that a file's content is about to be opened, by the path it is opened by: every core/io primitive calls it first,
 * and only core/io opens files (a static rule pins that), so a test hook sees every file the engine opens. A linked
 * store is reported by the path SQLite opens (`openRo` resolves the link); any other link is reported as given. A no-op
 * unless a test set a hook.
 */
export function noteOpen(path: string, how: OpenHow): void {
  observer?.(path, how);
}

/** Test hook: every file a core/io primitive opens is reported (`noteOpen`); undefined = off. */
export function __observeOpens(fn?: (path: string, how: OpenHow) => void): void {
  observer = fn;
}
