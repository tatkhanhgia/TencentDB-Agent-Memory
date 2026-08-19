/** tdai-reflect: session-end reflection CLI.
 *
 * Exit codes are a contract with the hook wrapper, so nothing here throws:
 *   0 success (written | empty | skipped | dry-run)
 *   2 bad usage or missing/invalid config
 *   3 transcript unreadable or unparseable
 *   4 LLM call failed
 *   5 memory write failed
 * stdout carries only the JSON result summary (plus --help usage).
 */

import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { createSdkMemoryPort, type MemoryReadPort } from "../client.js";
import { ConfigError, loadConfigFromEnv, type IdentityConfig } from "../config.js";
import { collectSecretValues, redactSecrets } from "../redact.js";
import {
  createOpenAiChatFn,
  DEFAULT_MAX_LESSONS,
  extractLessons,
  loadLlmConfigFromEnv,
  LlmError,
  MAX_LESSONS_CAP,
  type ChatFn,
  type Lesson,
} from "./extract.js";
import {
  isTranscriptFormat,
  lastTimestamp,
  parseTranscript,
  TRANSCRIPT_FORMATS,
  type TranscriptFormat,
} from "./transcript.js";
import { MemoryWriteError, writeLessons } from "./write.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_TRANSCRIPT = 3;
export const EXIT_LLM = 4;
export const EXIT_WRITE = 5;

export const DEFAULT_MIN_TURNS = 6;

export const USAGE = `tdai-reflect --transcript <path> --format <fmt> [options]

Reads a finished agent session transcript, decides whether it produced any
durable lesson (ADR, system-impacting change, project constraint, user
preference), and writes at most a few of them to MemoryCore L0.
Writing nothing is the normal outcome.

Options:
  --transcript <path>   transcript file (required)
  --format <fmt>        ${TRANSCRIPT_FORMATS.join(" | ")} (required)
  --session-id <id>     host session id; default: from the transcript, else
                        sha256 of the transcript path
  --max-lessons <n>     default ${DEFAULT_MAX_LESSONS}, hard cap ${MAX_LESSONS_CAP}
  --min-turns <n>       skip sessions with fewer text turns, default ${DEFAULT_MIN_TURNS}
  --dry-run             extract only; print lessons instead of writing
  --quiet               only errors on stderr
  -h, --help            print this help

Environment (all required, fail-closed):
  TDAI_ENDPOINT TDAI_API_KEY TDAI_SERVICE_ID TDAI_TEAM_ID TDAI_AGENT_ID TDAI_USER_ID
  TDAI_REFLECT_LLM_BASE_URL TDAI_REFLECT_LLM_API_KEY TDAI_REFLECT_LLM_MODEL
Optional: TDAI_TASK_ID, TDAI_REFLECT_TIMEOUT_MS (default 60000), TDAI_LOG_LEVEL.
--dry-run still requires the full environment; it only suppresses the write.

Exit codes: 0 ok, 2 usage/config, 3 transcript, 4 LLM, 5 memory write.
stdout is the JSON result summary only; diagnostics go to stderr.`;

export interface ReflectOptions {
  transcript: string;
  format: TranscriptFormat;
  sessionId?: string;
  maxLessons: number;
  minTurns: number;
  dryRun: boolean;
  quiet: boolean;
}

export type ArgsResult =
  | { kind: "help" }
  | { kind: "options"; options: ReflectOptions }
  | { kind: "error"; message: string };

function parseCount(raw: string, min: number, max: number): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function parseArgs(argv: readonly string[]): ArgsResult {
  let transcript: string | undefined;
  let format: string | undefined;
  let sessionId: string | undefined;
  let maxLessons = DEFAULT_MAX_LESSONS;
  let minTurns = DEFAULT_MIN_TURNS;
  let dryRun = false;
  let quiet = false;

  const valueOf = (value: string | undefined): string | null =>
    value === undefined || value.startsWith("--") ? null : value;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--dry-run":
        dryRun = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--transcript":
      case "--format":
      case "--session-id":
      case "--max-lessons":
      case "--min-turns": {
        const value = valueOf(argv[i + 1]);
        if (value === null) return { kind: "error", message: `${arg} requires a value` };
        i += 1;
        if (arg === "--transcript") transcript = value;
        else if (arg === "--format") format = value;
        else if (arg === "--session-id") sessionId = value;
        else if (arg === "--max-lessons") {
          const n = parseCount(value, 1, MAX_LESSONS_CAP);
          if (n === null) {
            return {
              kind: "error",
              message: `--max-lessons must be an integer 1-${MAX_LESSONS_CAP}`,
            };
          }
          maxLessons = n;
        } else {
          const n = parseCount(value, 0, 10_000);
          if (n === null) {
            return { kind: "error", message: "--min-turns must be a non-negative integer" };
          }
          minTurns = n;
        }
        break;
      }
      default:
        return { kind: "error", message: `unknown argument: ${arg}` };
    }
  }

  if (!transcript) return { kind: "error", message: "--transcript is required" };
  if (!format) return { kind: "error", message: "--format is required" };
  if (!isTranscriptFormat(format)) {
    return {
      kind: "error",
      message: `--format must be one of: ${TRANSCRIPT_FORMATS.join(", ")}`,
    };
  }

  const options: ReflectOptions = {
    transcript,
    format,
    maxLessons,
    minTurns,
    dryRun,
    quiet,
  };
  if (sessionId) options.sessionId = sessionId;
  return { kind: "options", options };
}

export type ReflectStatus = "written" | "empty" | "skipped" | "dry-run";

export interface ReflectSummary {
  status: ReflectStatus;
  lessons: Lesson[];
  written: number;
}

export interface ReflectDeps {
  env?: NodeJS.Dict<string>;
  readFile?: (path: string) => Promise<string>;
  /** Injected in tests; production builds one from TDAI_REFLECT_LLM_*. */
  chat?: ChatFn;
  createMemory?: (cfg: IdentityConfig) => MemoryReadPort;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface Diagnostics {
  warn(message: string): void;
  error(message: string): void;
}

function createDiagnostics(
  write: (text: string) => void,
  quiet: boolean,
  redact: (text: string) => string,
): Diagnostics {
  const emit = (level: string, message: string) => {
    write(`${new Date().toISOString()} [${level}] [tdai-reflect] ${redact(message)}\n`);
  };
  return {
    warn: (message) => {
      if (!quiet) emit("WARN", message);
    },
    error: (message) => emit("ERROR", message),
  };
}

export function deriveSessionId(
  explicit: string | undefined,
  fromTranscript: string | undefined,
  transcriptPath: string,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (fromTranscript?.trim()) return fromTranscript.trim();
  const hash = createHash("sha256").update(resolvePath(transcriptPath)).digest("hex");
  return hash.slice(0, 16);
}

/** Orchestration. Returns a process exit code; never throws. */
export async function run(argv: readonly string[], deps: ReflectDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  // The reflect LLM key is collected up front so it is redacted even when the
  // chat function is injected by a caller.
  const secrets = collectSecretValues(env, [env.TDAI_REFLECT_LLM_API_KEY ?? ""]);
  const redact = (text: string) => redactSecrets(text, secrets);

  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    stdout(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    stderr(`tdai-reflect: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  const log = createDiagnostics(stderr, options.quiet, redact);

  const emit = (summary: ReflectSummary): void => {
    stdout(`${JSON.stringify(summary)}\n`);
  };

  let identity: IdentityConfig;
  let chat: ChatFn;
  try {
    identity = loadConfigFromEnv(env);
    secrets.push(identity.apiKey);
    if (deps.chat) {
      chat = deps.chat;
    } else {
      const llm = loadLlmConfigFromEnv(env);
      chat = createOpenAiChatFn(llm, { warn: (message) => log.warn(message) });
    }
  } catch (err) {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    log.error(`configuration error: ${message}`);
    return EXIT_USAGE;
  }

  let raw: string;
  try {
    raw = await readFile(options.transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`cannot read transcript ${options.transcript}: ${message}`);
    return EXIT_TRANSCRIPT;
  }

  const transcript = parseTranscript(raw, options.format);
  if (transcript.lines > 0 && transcript.badLines === transcript.lines) {
    log.error(
      `transcript has ${transcript.lines} line(s) and none parsed as JSON; wrong --format?`,
    );
    return EXIT_TRANSCRIPT;
  }
  if (transcript.badLines > 0) {
    log.warn(`skipped ${transcript.badLines} unparseable line(s)`);
  }

  if (transcript.lines > 0 && transcript.turns.length === 0) {
    log.warn(
      `parsed ${transcript.lines} line(s) but extracted 0 turns — wrong --format?`,
    );
  }

  if (transcript.turns.length < options.minTurns) {
    log.warn(
      `prefilter: ${transcript.turns.length} text turn(s) < ${options.minTurns}, nothing to reflect on`,
    );
    emit({ status: "skipped", lessons: [], written: 0 });
    return EXIT_OK;
  }

  let lessons: Lesson[];
  try {
    const extracted = await extractLessons(transcript.turns, options.maxLessons, chat);
    for (const warning of extracted.warnings) log.warn(warning);
    lessons = extracted.lessons;
  } catch (err) {
    const message = err instanceof LlmError || err instanceof Error ? err.message : String(err);
    log.error(`extraction failed: ${message}`);
    return EXIT_LLM;
  }

  const sessionId = deriveSessionId(options.sessionId, transcript.sessionId, options.transcript);

  if (options.dryRun) {
    emit({ status: "dry-run", lessons, written: 0 });
    return EXIT_OK;
  }

  if (lessons.length === 0) {
    log.warn("no durable lessons in this session");
    emit({ status: "empty", lessons: [], written: 0 });
    return EXIT_OK;
  }

  const memory = (deps.createMemory ?? createSdkMemoryPort)(identity);
  // Written content is a pure function of the transcript. A wall-clock date
  // here would change the payload hash and make a retried hook conflict.
  const timestamp = lastTimestamp(transcript.turns);

  try {
    const result = await writeLessons(lessons, {
      memory,
      sessionId,
      format: options.format,
      ...(timestamp ? { timestamp, isoDate: timestamp } : {}),
      warn: log.warn,
    });
    if (result.duplicates.length > 0) {
      log.warn(`skipped ${result.duplicates.length} duplicate lesson(s)`);
    }
    emit({
      status: result.written.length > 0 ? "written" : "empty",
      lessons: result.written,
      written: result.written.length,
    });
    return EXIT_OK;
  } catch (err) {
    const message =
      err instanceof MemoryWriteError || err instanceof Error ? err.message : String(err);
    log.error(`memory write failed: ${message}`);
    return EXIT_WRITE;
  }
}

/** Entry point used by bin/tdai-reflect.mjs. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.Dict<string> = process.env,
): Promise<number> {
  try {
    return await run(argv, { env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tdai-reflect: unexpected failure: ${message}\n`);
    return EXIT_USAGE;
  }
}
