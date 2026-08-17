import { describe, expect, it } from "vitest";
import {
  captureScopeKey,
  evaluateCaptureReceipt,
  hashCapturePayload,
  type CaptureReceipt,
} from "../capture-receipt.js";

describe("capture-receipt", () => {
  it("hashes payload stably and changes when content changes", () => {
    const a = hashCapturePayload([{ role: "user", content: "hi" }]);
    const b = hashCapturePayload([{ role: "user", content: "hi" }]);
    const c = hashCapturePayload([{ role: "user", content: "bye" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("scopes receipts by isolation + session + capture_id", () => {
    const k1 = captureScopeKey({
      serviceId: "default",
      teamId: "t1",
      agentId: "a1",
      userId: "u1",
      sessionId: "s1",
      captureId: "cap-1",
    });
    const k2 = captureScopeKey({
      serviceId: "default",
      teamId: "t1",
      agentId: "a1",
      userId: "u1",
      sessionId: "s1",
      captureId: "cap-2",
    });
    const k3 = captureScopeKey({
      serviceId: "default",
      teamId: "t-other",
      agentId: "a1",
      userId: "u1",
      sessionId: "s1",
      captureId: "cap-1",
    });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("treats same hash as duplicate and different hash as conflict", () => {
    const receipt: CaptureReceipt = {
      scope_key: "k",
      payload_hash: hashCapturePayload([{ role: "user", content: "x" }]),
      accepted_ids: ["msg-1"],
      total_count: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    expect(evaluateCaptureReceipt(null, receipt.payload_hash).kind).toBe("miss");
    expect(evaluateCaptureReceipt(receipt, receipt.payload_hash).kind).toBe("duplicate");
    expect(
      evaluateCaptureReceipt(receipt, hashCapturePayload([{ role: "user", content: "y" }])).kind,
    ).toBe("conflict");
  });
});
