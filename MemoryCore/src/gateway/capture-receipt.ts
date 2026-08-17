import { createHash } from "node:crypto";

export interface CaptureReceipt {
  scope_key: string;
  payload_hash: string;
  accepted_ids: string[];
  total_count: number;
  created_at: string;
}

export function captureScopeKey(input: {
  serviceId: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
  sessionId: string;
  captureId: string;
}): string {
  return [
    input.serviceId,
    input.teamId ?? "",
    input.agentId ?? "",
    input.userId ?? "",
    input.taskId ?? "",
    input.sessionId,
    input.captureId,
  ].join("\u001f");
}

export function hashCapturePayload(messages: Array<{ role: string; content: string; timestamp?: string }>): string {
  const canonical = messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp ?? "",
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type CaptureIdempotency =
  | { kind: "miss" }
  | { kind: "duplicate"; receipt: CaptureReceipt }
  | { kind: "conflict"; receipt: CaptureReceipt };

export function evaluateCaptureReceipt(
  existing: CaptureReceipt | null | undefined,
  payloadHash: string,
): CaptureIdempotency {
  if (!existing) return { kind: "miss" };
  if (existing.payload_hash === payloadHash) return { kind: "duplicate", receipt: existing };
  return { kind: "conflict", receipt: existing };
}
