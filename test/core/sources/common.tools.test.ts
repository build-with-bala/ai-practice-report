import { describe, expect, test } from "bun:test";
import type { ToolEv } from "../../../core/model/events";
import type { CheckKind, ToolCategory } from "../../../core/model/ids";
import { withCheckCategory } from "../../../core/sources/common/tools";

const call = (category: ToolCategory, checks?: CheckKind[]): ToolEv => ({
  k: "tool", tool: "antigravity", source: "antigravity.cli", ts: 1, sessionId: "antigravity:x", name: "blaze_test_targets", category,
  ...(checks && { checks }),
});

describe("withCheckCategory", () => {
  test("a check category is listed in checks, first", () => {
    expect(withCheckCategory(call("test")).checks).toEqual(["test"]);
    expect(withCheckCategory(call("build", ["test"])).checks).toEqual(["build", "test"]);
    expect(withCheckCategory(call("typecheck")).checks).toEqual(["typecheck"]);
  });
  test("a check already listed, or a category that is no check, is left as it is", () => {
    expect(withCheckCategory(call("lint", ["lint", "test"])).checks).toEqual(["lint", "test"]);
    expect(withCheckCategory(call("read")).checks).toBeUndefined();
    expect(withCheckCategory(call("shell", ["test"])).checks).toEqual(["test"]);
  });
});
