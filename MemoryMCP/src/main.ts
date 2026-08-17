import { loadConfigFromEnv } from "./config.js";
import { createSdkMemoryPort } from "./client.js";
import { createStderrLogger } from "./logger.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";
import { collectSecretValues, redactSecrets } from "./redact.js";
import { startStdioServer } from "./server.js";

const secrets = collectSecretValues(process.env);
const redact = (msg: string) => redactSecrets(msg, secrets);
const log = createStderrLogger(process.env.TDAI_LOG_LEVEL, redact);

try {
  const config = loadConfigFromEnv(process.env);
  secrets.push(config.apiKey);
  const httpOpts = httpOptionsFromEnv(config, process.env, log);
  if (httpOpts) {
    for (const token of httpOpts.bindings.keys()) secrets.push(token);
    await startHttpServer(httpOpts);
  } else {
    const memory = createSdkMemoryPort(config);
    log.info("starting stdio server");
    await startStdioServer({ config, memory, log });
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`startup failed: ${message}`);
  process.exit(1);
}
