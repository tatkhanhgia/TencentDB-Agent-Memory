import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IdentityConfig } from "./config.js";
import type { MemoryReadPort } from "./client.js";
import type { Logger } from "./logger.js";
import { handleToolCall } from "./handlers.js";
import { listToolDescriptors } from "./tools.js";
import { redactSecrets } from "./redact.js";

export interface ServerDeps {
  config: IdentityConfig;
  memory: MemoryReadPort;
  log: Logger;
}

export function createMemoryMcpServer(deps: ServerDeps): Server {
  const secrets = [deps.config.apiKey];
  const redact = (msg: string) => redactSecrets(msg, secrets);

  const server = new Server(
    { name: "tdai-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDescriptors({
      captureEnabled: deps.config.captureEnabled,
      skillsEnabled: deps.config.skillsEnabled,
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await handleToolCall(name, args, {
      config: deps.config,
      memory: deps.memory,
    });
    const text = redact(result.text);
    if (result.isError) {
      deps.log.warn(`tool ${name} error: ${text}`);
    }
    return {
      content: [{ type: "text" as const, text }],
      isError: result.isError,
    };
  });

  return server;
}

export async function startStdioServer(deps: ServerDeps): Promise<void> {
  const server = createMemoryMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  deps.log.info("stdio transport connected");
}
