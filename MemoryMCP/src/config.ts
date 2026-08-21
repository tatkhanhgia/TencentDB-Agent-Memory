export const REQUIRED_ENV = [
  "TDAI_ENDPOINT",
  "TDAI_API_KEY",
  "TDAI_SERVICE_ID",
  "TDAI_TEAM_ID",
  "TDAI_AGENT_ID",
  "TDAI_USER_ID",
] as const;

export interface IdentityConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  timeoutMs: number;
  maxChars: number;
  logLevel: string;
  captureEnabled: boolean;
  conversationRef?: string;
  skillsEnabled: boolean;
  /**
   * The project this session runs in resolved to no agent of its own (no
   * .tdai-project.env, no Panel agent named after the folder), so the wrapper
   * fell back to the machine default. Serving that default's memory would show
   * one project another project's context and file this session's lessons
   * there — so memory reads answer empty and writes are refused. Skills are
   * team assets and stay visible.
   */
  identityUnbound: boolean;
}

export class ConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

function requireEnv(env: NodeJS.Dict<string>, name: (typeof REQUIRED_ENV)[number]): string {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new ConfigError(name, `missing required environment variable ${name}`);
  }
  return value;
}

function optionalEnv(env: NodeJS.Dict<string>, name: string): string | undefined {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(field, `${field} must be a positive number`);
  }
  return Math.floor(n);
}

/** Fail-closed identity. Never invents default/default/default bindings. */
export function loadConfigFromEnv(env: NodeJS.Dict<string> = process.env): IdentityConfig {
  const endpoint = requireEnv(env, "TDAI_ENDPOINT");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new ConfigError("TDAI_ENDPOINT", "TDAI_ENDPOINT must be a valid HTTP(S) URL");
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey: requireEnv(env, "TDAI_API_KEY"),
    serviceId: requireEnv(env, "TDAI_SERVICE_ID"),
    teamId: requireEnv(env, "TDAI_TEAM_ID"),
    agentId: requireEnv(env, "TDAI_AGENT_ID"),
    userId: requireEnv(env, "TDAI_USER_ID"),
    taskId: optionalEnv(env, "TDAI_TASK_ID"),
    timeoutMs: parsePositiveInt(env.TDAI_TIMEOUT_MS, 30_000, "TDAI_TIMEOUT_MS"),
    maxChars: parsePositiveInt(env.TDAI_MAX_CHARS, 12_288, "TDAI_MAX_CHARS"),
    logLevel: optionalEnv(env, "TDAI_LOG_LEVEL") ?? "info",
    captureEnabled: /^true|1|yes$/i.test(env.TDAI_ENABLE_CAPTURE ?? ""),
    conversationRef: optionalEnv(env, "TDAI_CONVERSATION_REF"),
    skillsEnabled: /^true|1|yes$/i.test(env.TDAI_ENABLE_SKILLS ?? ""),
    identityUnbound: /^true|1|yes$/i.test(env.TDAI_IDENTITY_UNBOUND ?? ""),
  };
}
