import { expect, test } from "bun:test";
import { techCategories } from "../../../core/text/tech";

test("unique terms per category, case-insensitive", () => {
  const r = techCategories("Postgres and postgres, plus Redis; OAuth with JWT");
  expect(r.data).toBe(2);
  expect(r.security).toBe(2);
  expect(r.infra).toBeUndefined();
});
test("multi-word and word boundary", () => {
  expect(techCategories("a race   condition in the event loop").systems).toBe(2);
  expect(techCategories("indexing the portfolio").data).toBeUndefined();
});
test("new groups", () => {
  const r = techCategories("react component with css, ios and android via swift and kotlin, an agent prompt, rag over a model");
  expect(r.frontend).toBe(3);
  expect(r.mobile).toBe(4);
  expect(r.ai).toBe(4);
});
test("none", () => expect(techCategories("hello there")).toEqual({}));
