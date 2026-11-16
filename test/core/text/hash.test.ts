import { expect, test } from "bun:test";
import { keyedHash, normalizePath } from "../../../core/text/hash";

const s1 = new Uint8Array([1, 2, 3]);
const s2 = new Uint8Array([4, 5, 6]);
test("keyedHash stable, hex, salt-dependent", () => {
  const h = keyedHash(s1, "/a/b");
  expect(h).toMatch(/^[0-9a-f]{16}$/);
  expect(keyedHash(s1, "/a/b")).toBe(h);
  expect(keyedHash(s2, "/a/b")).not.toBe(h);
  expect(keyedHash(s1, "/a/c")).not.toBe(h);
  expect(keyedHash(s1, "x", 32)).toHaveLength(32);
});
test("normalizePath", () => {
  expect(normalizePath("C:\\Users\\A\\proj\\")).toBe("c:/Users/A/proj");
  expect(normalizePath("/a/b/../c/")).toBe("/a/c");
  expect(normalizePath("/a/./b//c")).toBe("/a/b/c");
  expect(normalizePath("/")).toBe("/");
  expect(normalizePath("/../a")).toBe("/a");
  expect(normalizePath("a/../../b")).toBe("../b");
  expect(normalizePath("D:\\")).toBe("d:/");
  expect(normalizePath("/Users/Jo Ann/Application Support/")).toBe("/Users/Jo Ann/Application Support");
  expect(normalizePath("")).toBe("");
});
