import { describe, expect, it } from "vitest";
import { PathError, validateScenePath } from "../src/paths.js";

describe("validateScenePath", () => {
  it("accepts a relative scene path", () => {
    expect(validateScenePath("auth.md")).toBe("auth.md");
    expect(validateScenePath("nested/auth.md")).toBe("nested/auth.md");
  });

  it("strips the scene_blocks/ storage prefix from persona scene-index paths", () => {
    expect(validateScenePath("scene_blocks/auth.md")).toBe("auth.md");
    expect(validateScenePath("scene_blocks\\auth.md")).toBe("auth.md");
    // only the leading storage prefix is stripped, not inner segments
    expect(validateScenePath("foo/scene_blocks/auth.md")).toBe("foo/scene_blocks/auth.md");
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
