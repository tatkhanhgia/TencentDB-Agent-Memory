import { describe, expect, it } from "vitest";

import { buildFtsQuery } from "./sqlite.js";

/**
 * Regression guard for the FTS5 query builder.
 *
 * jieba only knows CJK. When it was applied to every language, Latin-script
 * input came back segmented per character: "móc nối cuối" → "m" OR "ó" OR "c"
 * OR "n" OR "ố" OR "i". Those single letters matched almost every stored row,
 * and because hybrid recall merges FTS and vector hits with unweighted RRF,
 * the junk matches won ties against the vector hit that was actually correct —
 * a real Vietnamese query ranked its right answer #1 by vector and still fell
 * out of the top 3 after merging.
 */
describe("buildFtsQuery", () => {
  const tokens = (q: string) =>
    (buildFtsQuery(q) ?? "").split(" OR ").filter(Boolean).map((t) => t.replaceAll('"', ""));

  it("splits Vietnamese on word boundaries, not per character", () => {
    const t = tokens("móc nối cuối phiên phải cài ở cấu hình");
    expect(t).toContain("móc");
    expect(t).toContain("nối");
    expect(t).toContain("cuối");
    expect(t).toContain("phiên");
    // "ở" is a genuine one-letter Vietnamese word; the failure mode is many of
    // them, so assert on the shape of the split rather than banning length 1.
    expect(t.filter((x) => x.length === 1).length).toBeLessThanOrEqual(1);
  });

  it("still segments Chinese with jieba", () => {
    const t = tokens("旅行计划 API 设计");
    expect(t).toContain("旅行");
    expect(t).toContain("计划");
    expect(t).toContain("API");
  });

  it("keeps English words and code identifiers intact", () => {
    expect(tokens("reflect hook user-level settings")).toEqual(
      expect.arrayContaining(["reflect", "hook", "user", "level", "settings"]),
    );
    expect(tokens("USP_ENTERPRISE_GET stored procedure")).toContain("USP_ENTERPRISE_GET");
  });

  it("returns null when there is nothing searchable", () => {
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("!!! ???")).toBeNull();
  });
});
