import { expect, test } from "bun:test";
import { VERSION } from "../core/index";
import pkg from "../package.json";

test("VERSION matches package.json", () => {
  expect(VERSION).toBe(pkg.version);
  expect(VERSION).toBe("1.0.0-dev");
});
