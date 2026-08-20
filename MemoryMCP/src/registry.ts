import type { NamedIdentity } from "./bindings.js";

/**
 * Live identity source: the Core agent registry (what the Panel shows).
 * Tokens declared with `"identities": "registry"` resolve their identity
 * list here on session creation, so an agent created in the web UI appears
 * in the picker without any manual sync. Results are cached briefly; the
 * last successful list is served if a refresh fails.
 */
export interface RegistryOptions {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  userId: string;
  ttlMs?: number;
  timeoutMs?: number;
}

interface RegistryAgent {
  agent_id?: unknown;
  team_id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function agentsToIdentities(items: RegistryAgent[], userId: string): NamedIdentity[] {
  const identities: NamedIdentity[] = [];
  const names = new Set<string>();
  for (const a of items) {
    if (a.status !== "active") continue;
    const agentId = String(a.agent_id ?? "").trim();
    const teamId = String(a.team_id ?? "").trim();
    if (!agentId || !teamId) continue;
    let name = slug(String(a.name ?? agentId));
    while (names.has(name)) name = `${name}-2`;
    names.add(name);
    identities.push({
      name,
      description: String(a.description ?? "").trim() || String(a.name ?? "").trim() || undefined,
      teamId,
      agentId,
      userId,
    });
  }
  return identities;
}

export type IdentityProvider = () => Promise<NamedIdentity[]>;

export function createRegistryIdentityProvider(opts: RegistryOptions): IdentityProvider {
  const ttl = opts.ttlMs ?? 30_000;
  const timeout = opts.timeoutMs ?? 10_000;
  let cached: NamedIdentity[] | null = null;
  let fetchedAt = 0;
  let inFlight: Promise<NamedIdentity[]> | null = null;

  async function refresh(): Promise<NamedIdentity[]> {
    const res = await fetch(`${opts.endpoint.replace(/\/+$/, "")}/v3/meta/agent/list`, {
      method: "POST",
      headers: {
        // Meta-plane auth: user key travels in its own header.
        authorization: "Bearer local",
        "x-tdai-user-key": opts.apiKey,
        "x-tdai-service-id": opts.serviceId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ team_id: opts.teamId, limit: 100 }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`agent registry HTTP ${res.status}`);
    const parsed = (await res.json()) as { code?: number; message?: string; data?: { items?: RegistryAgent[] } };
    if (parsed.code !== 0) throw new Error(`agent registry error: ${parsed.message ?? "unknown"}`);
    const identities = agentsToIdentities(parsed.data?.items ?? [], opts.userId);
    if (identities.length === 0) throw new Error("agent registry returned no active agents");
    cached = identities;
    fetchedAt = Date.now();
    return identities;
  }

  return async () => {
    if (cached && Date.now() - fetchedAt < ttl) return cached;
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    try {
      return await inFlight;
    } catch (err) {
      // Serve the last known list on refresh failure; fail only when we
      // have never seen the registry at all.
      if (cached) return cached;
      throw err;
    }
  };
}
