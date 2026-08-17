import { describe, expect, it } from "vitest";
import { PathError, validateScenePath } from "../src/paths.js";

describe("validateScenePath", () => {
  it("accepts a relative scene path", () => {
    expect(validateScenePath("scene_blocks/auth.md")).toBe("scene_blocks/auth.md");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => validateScenePath("../etc/passwd")).toThrow(PathError);
    expect(() => validateScenePath("/etc/passwd")).toThrow(PathError);
    expect(() => validateScenePath("foo/../bar")).toThrow(PathError);
    expect(() => validateScenePath("C:\\windows\\x")).toThrow(PathError);
    expect(() => validateScenePath("")).toThrow(PathError);
    expect(() => validateScenePath("a\0b")).toThrow(PathError);
  });
});
