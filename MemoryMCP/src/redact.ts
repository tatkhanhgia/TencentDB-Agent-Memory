const SECRET_ENV_KEYS = [
  "TDAI_API_KEY",
  "TDAI_USER_KEY",
  "AUTHORIZATION",
] as const;

/** Keys that must never appear as tool input overrides. */
export const IDENTITY_OVERRIDE_KEYS = [
  "team_id",
  "teamId",
  "agent_id",
  "agentId",
  "user_id",
  "userId",
  "task_id",
  "taskId",
  "service_id",
  "serviceId",
  "endpoint",
  "api_key",
  "apiKey",
  "api-key",
  "authorization",
  "token",
  "TDAI_ENDPOINT",
  "TDAI_API_KEY",
  "TDAI_SERVICE_ID",
  "TDAI_TEAM_ID",
  "TDAI_AGENT_ID",
  "TDAI_USER_ID",
  "TDAI_TASK_ID",
] as const;

export function collectSecretValues(env: NodeJS.Dict<string>, extra: string[] = []): string[] {
  const out: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const v = env[key];
    if (v && v.trim()) out.push(v);
  }
  for (const v of extra) {
    if (v && v.trim()) out.push(v);
  }
  return out;
}

/** Replace known secrets in a string. Longer secrets first to avoid partial overlap. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  const sorted = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function walkObjectKeys(value: unknown, visit: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjectKeys(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k);
      walkObjectKeys(v, visit);
    }
  }
}
