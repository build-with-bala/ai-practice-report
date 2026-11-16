import type { SourcePlugin } from "./types";

/** Tool-reader plugins; each plugin module pushes itself here (Tasks 9-15). */
export const registry: SourcePlugin[] = [];
