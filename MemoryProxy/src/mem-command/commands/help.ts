/**
 * mem:help — list supported commands and examples
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `**Supported mem: commands:**

| Command | Description |
|---------|-------------|
| \`mem:sync\` | Refresh all asset injections for this session (Skill / Memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [hint]\` | Archive this conversation as a Skill (async extraction in the background) |
| \`mem:help\` | Show this help |

**Examples:**
\`\`\`
mem:sync
mem:create-skill summarize database migration steps and pitfalls
mem:help
\`\`\`

Use \`mem:<command>\` with no space after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
