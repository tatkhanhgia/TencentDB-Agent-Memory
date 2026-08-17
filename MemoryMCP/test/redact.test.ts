import { describe, expect, it } from "vitest";
import { createStderrLogger } from "../src/logger.js";
import { collectSecretValues, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("replaces the API key and never leaves the raw secret", () => {
    const key = "sk-mem-SUPERSECRET";
    const out = redactSecrets(`Authorization Bearer ${key} ok`, [key]);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(key);
  });

  it("collects TDAI_API_KEY from env", () => {
    const secrets = collectSecretValues({ TDAI_API_KEY: "sk-from-env" });
    expect(secrets).toContain("sk-from-env");
  });

  it("logger writes only to the stderr sink and redacts", () => {
    const lines: string[] = [];
    const key = "sk-mem-LOGGER";
    const log = createStderrLogger("info", (m) => redactSecrets(m, [key]), (line) => {
      lines.push(line);
    });
    log.info(`hello ${key}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(key);
    expect(lines[0]).toContain("[REDACTED]");
  });
});
