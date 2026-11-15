import { closeSync, fsyncSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { logPath } from "../config/paths";
import { TOKEN_PATTERNS } from "../security/token-pattern";

export const ALLOWED_FIELDS = [
  "method",
  "route",
  "status",
  "code",
  "op",
  "t",
  "seq",
  "close_code",
  "guild_id",
  "channel_id",
  "message_id",
  "state",
  "attempt",
  "duration_ms",
  "error_name",
  "msg",
  "count",
  "mode",
  "packets",
  "decode_errors",
  "peak_db",
  "ref_db",
  "underruns",
  "jitter_drops",
  "jitter_ms_max",
  "concealed",
  "arrival_p95_ms",
  "arrival_max_ms",
  "late_ticks",
  "skipped_frames",
  "loop_lag_max_ms",
  "playback_pending",
  "playback_dropped",
] as const;

export type AllowedField = (typeof ALLOWED_FIELDS)[number];
export type LogFields = Partial<Record<AllowedField, string | number | boolean | null>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  flush(): Promise<void>;
}

const allowed = new Set<string>(ALLOWED_FIELDS);

function redactTokens(value: string): string {
  let out = value;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function createLogger(opts: { file?: string; maxBytes?: number } = {}): Logger {
  const file = opts.file ?? logPath();
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  let fd: number | null = null;
  let bytes = 0;

  function ensureOpen(): void {
    if (fd !== null) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    fd = openSync(file, "a", 0o600);
    try {
      bytes = fstatSync(fd).size;
    } catch {
      bytes = 0;
    }
  }

  function rotate(): void {
    if (fd === null) return;
    closeSync(fd);
    fd = null;
    try {
      renameSync(file, `${file}.1`);
    } catch {
      // sin permiso o ya no existe: seguimos appendando al mismo archivo
    }
    bytes = 0;
    ensureOpen();
  }

  function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event: redactTokens(event),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.has(key)) {
        record[key] = "[dropped]";
      } else {
        record[key] = typeof value === "string" ? redactTokens(value) : value;
      }
    }
    const line = JSON.stringify(record) + "\n";
    ensureOpen();
    if (bytes > 0 && bytes + Buffer.byteLength(line, "utf8") > maxBytes) rotate();
    writeSync(fd!, line);
    bytes += Buffer.byteLength(line, "utf8");
  }

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    flush: async () => {
      if (fd !== null) fsyncSync(fd);
    },
  };
}

let defaultLogger: Logger | null = null;
let defaultFile: string | null = null;

function defaultLoggerForCurrentPath(): Logger {
  const file = logPath();
  if (defaultLogger === null || defaultFile !== file) {
    defaultLogger = createLogger({ file });
    defaultFile = file;
  }
  return defaultLogger;
}

export const log: Logger = {
  info: (event, fields) => defaultLoggerForCurrentPath().info(event, fields),
  warn: (event, fields) => defaultLoggerForCurrentPath().warn(event, fields),
  error: (event, fields) => defaultLoggerForCurrentPath().error(event, fields),
  flush: () => defaultLoggerForCurrentPath().flush(),
};
