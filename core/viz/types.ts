/*
 * The kit's input types for the exhibit frame, the seal and the assay ledger. They are self-contained: the report apps
 * map their analysis onto them, so the primitives never depend on an analysis type.
 */

/** A ledger row's state: scored, or why it is not (too little data, not measurable on this machine, not measured). */
export type RowStatus = "scored" | "insufficient" | "not-measurable" | "not-measured";

/** One component of a ledger row: a weighted input with its value, its z against reference v0, and the exhibits it cites. */
export interface LedgerComponent {
  id: string;
  label: string;
  weight: number;
  status: "ok" | "not-measurable" | "not-measured";
  value: string;
  z: number | null;
  n: number;
  cites?: string[];
}

/** One dimension of the assay ledger: a score on 0–100 with its interval, confidence and window. */
export interface LedgerRow {
  id: string;
  label: string;
  status: RowStatus;
  score: number | null;
  interval: readonly [number, number] | null;
  openTail: boolean;
  confidence: "low" | "medium" | "high" | null;
  window: "detail" | "lifetime";
  /** Free text shown under an unscored row's rule; never parsed. */
  note?: string;
  /** For an unscored row: the evidence count and the count it needs. Both finite non-negative integers give the value token `n=<n>/<needs>`. */
  n?: number;
  needs?: number;
  components: LedgerComponent[];
}

/** A labelled group of ledger rows, e.g. "Working with agents". */
export interface LedgerGroup {
  label: string;
  rows: LedgerRow[];
}

/** The seal: struck when the overall is scored and no check failed, provisional when it is insufficient, flagged when the data is inconsistent. */
export interface SealInput {
  state: "struck" | "provisional" | "flagged";
  label: string;
  score: number | null;
  interval: readonly [number, number] | null;
  coverage: string;
  /**
   * The ring text. Its last " · " (`RING_SEPARATOR` in seal.ts) splits it: the part before runs over the top of the
   * ring, the part after under it, both upright, e.g. "AI practice report · No. 7F3A-91C2 · 18 Nov 2026".
   */
  ringText: string;
}

/** The exhibit frame: `<figure class="exhibit" id>` with its letter, title, tag, body and one-sentence caption. */
export interface FigureOptions {
  id: string;
  letter: string;
  title: string;
  tag: string;
  caption: string;
  body: string;
  state?: "ok" | "thin" | "empty";
  note?: string;
}
