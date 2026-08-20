import { describe, expect, it } from "vitest";
import { IDENTITY_OVERRIDE_KEYS, walkObjectKeys } from "../src/redact.js";
import { CAPTURE_TOOL, SKILL_TOOLS, listToolDescriptors, TOOL_NAMES, TOOLS } from "../src/tools.js";

describe("tool schemas", () => {
  it("advertises exactly the four P0 read tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(listToolDescriptors().map((t) => t.name)).toEqual([
      "tdai_memory_context",
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_scene_read",
    ]);
  });

  it("contains no identity / endpoint / API-key override fields", () => {
    const forbidden = new Set<string>(IDENTITY_OVERRIDE_KEYS);
    const seen: string[] = [];
    for (const tool of [...TOOLS, CAPTURE_TOOL, ...SKILL_TOOLS]) {
      walkObjectKeys(tool.inputSchema, (key) => {
        if (forbidden.has(key)) seen.push(`${tool.name}.${key}`);
      });
    }
    expect(seen).toEqual([]);
  });

  it("lists capture/skill tools only when enabled", () => {
    expect(listToolDescriptors().map((t) => t.name)).not.toContain("tdai_memory_capture");
    expect(listToolDescriptors({ captureEnabled: true }).map((t) => t.name)).toContain(
      "tdai_memory_capture",
    );
    expect(listToolDescriptors({ skillsEnabled: true }).map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "tdai_skill_search",
        "tdai_skill_get",
        "tdai_skill_file_read",
      ]),
    );
  });

  it("rejects additional properties on every tool", () => {
    for (const tool of [...TOOLS, CAPTURE_TOOL, ...SKILL_TOOLS]) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});
