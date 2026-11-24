import { describe, expect, test } from "bun:test";
import { typedText } from "../../../core/sources/claude-code/origin";
import { promptText } from "../../../core/sources/codex/rollouts";
import { cxToolCalls } from "../../../core/sources/codex/tools";
import { userText } from "../../../core/sources/copilot/cli";
import { classifyCommand } from "../../../core/text/commands";

/**
 * Trace text is matched synchronously, so a pattern that backtracks over a long line holds the scan (and a trapped
 * Ctrl-C) for as long as it runs. Each input here is at least 200,000 characters of the shape that made a pattern
 * super-linear; the test's own 30 s timeout is the only bound, and the result proves the input was read.
 */
const N = 200_000;

describe("reader text patterns take linear time on adversarial trace text", () => {
  test("Claude Code: a slash-command wrapper whose name tag never closes, and many unclosed args tags", () => {
    const head = "<command-message>x</command-message>";
    expect(typedText(`${head}<command-name>${" ".repeat(N)}`)).toBe(`${head}<command-name>${" ".repeat(N)}`);
    const args = "<command-args>".repeat(N / 14);
    expect(typedText(`${head}<command-name>/fix</command-name>${args}`)).toBe("/fix");
    expect(typedText(`${head}${"<command-name>".repeat(N / 14)}`).length).toBeGreaterThan(N - 14);
    // the ordinary forms still read
    expect(typedText(`${head}<command-name>/review</command-name><command-args> a b </command-args>`)).toBe("/review a b");
    expect(typedText(`${head}<command-name> /x </command-name>`)).toBe("/x");
    expect(typedText(`${head}<command-name>/a<b</command-name><command-name>/c</command-name>`)).toBe("/c");
  });

  test("Codex: an image wrapper part followed by a long run of spaces", () => {
    // not a wrapper part (text follows), so it is kept, and then read as text the CLI wrote (it opens with an image tag)
    expect(promptText([{ type: "input_text", text: `<image>${" ".repeat(N)}x` }])).toBeUndefined();
    expect(promptText([{ type: "input_text", text: `<image>${" ".repeat(N)}x` }, { type: "input_text", text: "Hi" }])).toBeUndefined();
    expect(promptText([{ type: "input_text", text: `<image name=[Image #1]>${" ".repeat(N)}</image>` }, { type: "input_text", text: "Hi" }])?.text).toBe("Hi");
    expect(promptText([{ type: "input_text", text: "<image_resize_notice>x</image_resize_notice>" }, { type: "input_text", text: "Ok" }])?.text).toBe("Ok");
  });

  test("Codex: an apply_patch call whose heredoc openings repeat", () => {
    const r = cxToolCalls({ type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: `apply_patch ${'<<"a'.repeat(N / 4)}` }) });
    expect(Array.isArray(r) ? r.length : 1).toBeGreaterThanOrEqual(0); // it returns
  });

  test("Copilot CLI: many context tags that never close, and a pr_metadata tag that never ends", () => {
    expect(userText("<reminder>".repeat(N / 10))).toBe("<reminder>".repeat(N / 10));
    expect(userText("<pr_metadata".repeat(N / 12))).toBe("<pr_metadata".repeat(N / 12));
    expect(userText(`<reminder>a</reminder>  <context>b</context>Fix it<pr_metadata x="1"/> `)).toBe("Fix it");
  });

  test("the check classifier: a command behind a long run of wrappers", () => {
    const line = `${"env ".repeat(N / 4)}npm test`;
    expect(line.length).toBeGreaterThanOrEqual(N);
    expect(classifyCommand(line).checks).toEqual(["test"]);
    expect(classifyCommand(`${"A=1 ".repeat(N / 4)}cargo test`).checks).toEqual(["test"]);
  });
});
