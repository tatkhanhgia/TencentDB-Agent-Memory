import { MemoryClient, SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { IdentityConfig } from "./config.js";

export interface AtomicSearchInput {
  query: string;
  limit: number;
  type?: string;
  time_start?: string;
  time_end?: string;
}

export interface ConversationSearchInput {
  query: string;
  limit: number;
  time_start?: string;
  time_end?: string;
}

export interface ConversationAddInput {
  session_id: string;
  capture_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
}

/**
 * Thin port. Production wraps MemoryClient v3.
 * Tests inject fixtures without going through HTTP.
 */
export interface MemoryReadPort {
  searchAtomic(req: AtomicSearchInput): Promise<unknown>;
  searchConversation(req: ConversationSearchInput): Promise<unknown>;
  listScenarios(): Promise<unknown>;
  readScenario(path: string): Promise<unknown>;
  readCore(): Promise<unknown>;
  addConversation?(req: ConversationAddInput): Promise<unknown>;
  searchSkills?(req: { query: string; limit: number }): Promise<unknown>;
  getSkill?(req: { skill_id: string }): Promise<unknown>;
  recallBundle?(req: { query: string; max_items: number }): Promise<unknown>;
}

export function createSdkMemoryPort(cfg: IdentityConfig): MemoryReadPort {
  const client = new MemoryClient({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    serviceId: cfg.serviceId,
    teamId: cfg.teamId,
    agentId: cfg.agentId,
    userId: cfg.userId,
    taskId: cfg.taskId,
    timeout: cfg.timeoutMs,
  });
  const skills = cfg.skillsEnabled
    ? new SkillClient({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        serviceId: cfg.serviceId,
        teamId: cfg.teamId,
        agentId: cfg.agentId,
        userId: cfg.userId,
        taskId: cfg.taskId,
        timeout: cfg.timeoutMs,
      })
    : undefined;

  return {
    searchAtomic(req) {
      return client.searchAtomic(req);
    },
    searchConversation(req) {
      return client.searchConversation(req);
    },
    listScenarios() {
      return client.listScenarios({});
    },
    readScenario(path) {
      return client.readScenario({ path });
    },
    readCore() {
      return client.readCore();
    },
    recallBundle(req) {
      return client.recallBundle(req);
    },
    addConversation(req) {
      return client.addConversation({
        session_id: req.session_id,
        capture_id: req.capture_id,
        messages: req.messages,
      });
    },
    searchSkills: skills
      ? (req) => skills.search({ query: req.query, top_k: req.limit })
      : undefined,
    getSkill: skills ? (req) => skills.get({ skill_id: req.skill_id }) : undefined,
  };
}
