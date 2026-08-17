import { describe, expect, it } from "vitest";
import { ConfigError, loadConfigFromEnv, REQUIRED_ENV } from "../src/config.js";

const valid: NodeJS.Dict<string> = {
  TDAI_ENDPOINT: "http://127.0.0.1:8420",
  TDAI_API_KEY: "sk-test-secret",
  TDAI_SERVICE_ID: "default",
  TDAI_TEAM_ID: "team-a",
  TDAI_AGENT_ID: "agt-a",
  TDAI_USER_ID: "usr-a",
};

describe("loadConfigFromEnv", () => {
  it("loads a complete identity and optional task", () => {
    const cfg = loadConfigFromEnv({ ...valid, TDAI_TASK_ID: "task-a" });
    expect(cfg.endpoint).toBe("http://127.0.0.1:8420");
    expect(cfg.apiKey).toBe("sk-test-secret");
    expect(cfg.teamId).toBe("team-a");
    expect(cfg.taskId).toBe("task-a");
    expect(cfg.captureEnabled).toBe(false);
    expect(cfg.skillsEnabled).toBe(false);
  });

  it("enables capture only when TDAI_ENABLE_CAPTURE is true", () => {
    expect(loadConfigFromEnv({ ...valid, TDAI_ENABLE_CAPTURE: "true" }).captureEnabled).toBe(true);
  });

  it("fails closed for each required env var", () => {
    for (const key of REQUIRED_ENV) {
      const env = { ...valid };
      delete env[key];
      expect(() => loadConfigFromEnv(env)).toThrow(ConfigError);
      try {
        loadConfigFromEnv(env);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).field).toBe(key);
      }
    }
  });

  it("rejects blank / whitespace-only required values", () => {
    expect(() => loadConfigFromEnv({ ...valid, TDAI_API_KEY: "   " })).toThrow(
      /TDAI_API_KEY/,
    );
  });

  it("does not invent default/default/default bindings", () => {
    const env: NodeJS.Dict<string> = { TDAI_ENDPOINT: "http://127.0.0.1:8420" };
    expect(() => loadConfigFromEnv(env)).toThrow(ConfigError);
  });

  it("rejects a non-HTTP endpoint", () => {
    expect(() => loadConfigFromEnv({ ...valid, TDAI_ENDPOINT: "ftp://x" })).toThrow(
      /HTTP/,
    );
  });
});
