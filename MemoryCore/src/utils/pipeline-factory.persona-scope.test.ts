import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/record/l1-extractor.js", () => ({
  extractL1Memories: vi.fn(),
}));

import { extractL1Memories } from "../core/record/l1-extractor.js";
import { CheckpointManager } from "./checkpoint.js";
import { createL1Runner } from "./pipeline-factory.js";

const mockedExtractL1Memories = vi.mocked(extractL1Memories);

describe("L1 persona checkpoint scope", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mockedExtractL1Memories.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("increments the matching per-agent checkpoint, not the root checkpoint", async () => {
    const dataDir = await fs.mkdtemp(path.join("/tmp", "memorycore-persona-scope-"));
    tempDirs.push(dataDir);
    mockedExtractL1Memories.mockResolvedValue({
      success: true,
      extractedCount: 3,
      storedCount: 3,
      records: [],
      sceneNames: [],
      lastSceneName: "scene-1",
    });

    const vectorStore = {
      isDegraded: () => false,
      queryL0GroupedBySessionId: vi.fn().mockResolvedValue([{
        sessionId: "session-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        messages: [{ id: "m-1", role: "user", content: "hello", timestamp: 1, recordedAtMs: 100 }],
      }]),
    } as any;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

    const runner = createL1Runner({
      pluginDataDir: dataDir,
      cfg: {
        extraction: { enableDedup: false, maxMemoriesPerSession: 10, model: "test", promptMode: "default" },
        embedding: { conflictRecallTopK: 0, timeoutMs: 1000 },
      } as any,
      openclawConfig: {},
      teamId: "team-1",
      agentId: "agent-1",
      vectorStore,
      embeddingService: undefined,
      logger,
    });

    await runner({ sessionKey: "session-1" });

    const scope = "team:team-1|agent:agent-1";
    const scopedCheckpoint = new CheckpointManager(path.join(dataDir, "profiles", encodeURIComponent(scope)), logger);
    await expect(scopedCheckpoint.read()).resolves.toMatchObject({
      memories_since_last_persona: 3,
      total_memories_extracted: 3,
    });
    await expect(fs.access(path.join(dataDir, ".metadata", "checkpoint.json"))).rejects.toThrow();

    await scopedCheckpoint.markPersonaGenerated(3);
    await expect(scopedCheckpoint.read()).resolves.toMatchObject({ memories_since_last_persona: 0 });
  });
});
