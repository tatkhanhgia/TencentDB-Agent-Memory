import { createHash } from "node:crypto";
import type { IdentityConfig } from "./config.js";

/** Namespace a host conversation_ref under the frozen MCP identity. */
export function namespaceConversationRef(cfg: IdentityConfig, ref: string): string {
  const basis = [cfg.serviceId, cfg.teamId, cfg.agentId, cfg.userId, cfg.taskId ?? ""].join(":");
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 16);
  return `mcp_${hash}_${ref}`;
}
