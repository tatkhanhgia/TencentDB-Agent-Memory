import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

describe("AssetEntity.last_memory_at", () => {
  let store: SqliteMetadataStore;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  function createAsset() {
    return store.createAsset({
      asset_id: "asset-last-memory",
      team_id: "team-test",
      asset_type: "skill",
      name: "Last memory test",
      owner_user_id: "user-test",
      source_type: "manual",
    });
  }

  it("asset mới tạo có last_memory_at là null", () => {
    const asset = createAsset();

    expect(asset.last_memory_at).toBeNull();
    expect(store.getAssetById(asset.asset_id)?.last_memory_at).toBeNull();
  });

  it("touch cập nhật last_memory_at nhưng không đổi updated_at", () => {
    const asset = createAsset();
    const at = "2026-08-24T10:00:00.000Z";

    store.touchAssetMemory(asset.asset_id, at);

    const got = store.getAssetById(asset.asset_id);
    expect(got?.last_memory_at).toBe(at);
    expect(got?.updated_at).toBe(asset.updated_at);
  });

  it("touch với mốc cũ hơn giữ nguyên giá trị", () => {
    const asset = createAsset();
    const newer = "2026-08-24T10:00:00.000Z";
    const older = "2026-08-24T09:00:00.000Z";

    store.touchAssetMemory(asset.asset_id, newer);
    store.touchAssetMemory(asset.asset_id, older);

    expect(store.getAssetById(asset.asset_id)?.last_memory_at).toBe(newer);
  });

  it("touch với mốc mới hơn sẽ cập nhật", () => {
    const asset = createAsset();
    const older = "2026-08-24T09:00:00.000Z";
    const newer = "2026-08-24T10:00:00.000Z";

    store.touchAssetMemory(asset.asset_id, older);
    store.touchAssetMemory(asset.asset_id, newer);

    expect(store.getAssetById(asset.asset_id)?.last_memory_at).toBe(newer);
  });

  it("touch asset không tồn tại không throw", () => {
    expect(() => store.touchAssetMemory("asset-khong-ton-tai", "2026-08-24T10:00:00.000Z")).not.toThrow();
  });

  it("updateAsset không được ghi last_memory_at", () => {
    const asset = createAsset();
    const original = "2026-08-24T10:00:00.000Z";

    store.touchAssetMemory(asset.asset_id, original);
    store.updateAsset(asset.asset_id, { last_memory_at: "x" } as any);

    expect(store.getAssetById(asset.asset_id)?.last_memory_at).toBe(original);
  });
});
