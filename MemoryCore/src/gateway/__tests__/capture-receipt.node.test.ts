import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureScopeKey,
  evaluateCaptureReceipt,
  hashCapturePayload,
} from "../capture-receipt.js";

describe("shipped capture-receipt", () => {
  it("duplicate vs conflict", () => {
    const hash = hashCapturePayload([{ role: "user", content: "same" }]);
    const receipt = {
      scope_key: "k",
      payload_hash: hash,
      accepted_ids: ["msg-1"],
      total_count: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(evaluateCaptureReceipt(null, hash).kind, "miss");
    assert.equal(evaluateCaptureReceipt(receipt, hash).kind, "duplicate");
    assert.equal(
      evaluateCaptureReceipt(receipt, hashCapturePayload([{ role: "user", content: "other" }])).kind,
      "conflict",
    );
    const k1 = captureScopeKey({
      serviceId: "s",
      teamId: "t",
      agentId: "a",
      userId: "u",
      sessionId: "sess",
      captureId: "c1",
    });
    const k2 = captureScopeKey({
      serviceId: "s",
      teamId: "t",
      agentId: "a",
      userId: "u",
      sessionId: "sess",
      captureId: "c2",
    });
    assert.notEqual(k1, k2);
  });
});
