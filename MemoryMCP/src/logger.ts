export type LogLevel = "debug" | "info" | "warn" | "error";

const PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Stdio MCP must keep stdout protocol-only. All diagnostics go to stderr.
 * Never use console.log here.
 */
export function createStderrLogger(
  level: string | undefined,
  redact: (msg: string) => string = (m) => m,
  sink: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Logger {
  const normalized = (["debug", "info", "warn", "error"].includes(level ?? "")
    ? level
    : "info") as LogLevel;
  const min = PRIORITY[normalized];

  const write = (lvl: LogLevel, msg: string) => {
    if (PRIORITY[lvl] < min) return;
    const line = `${new Date().toISOString()} [${lvl.toUpperCase()}] [tdai-memory-mcp] ${redact(msg)}`;
    sink(line);
  };

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}
