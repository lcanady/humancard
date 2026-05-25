/**
 * Structured JSON logger for the humancard codebase.
 *
 * Every log line is a single-line JSON object with `time`, `level`, `msg`,
 * plus any caller-supplied fields. Output goes to `process.stdout` (errors
 * and warnings to `process.stderr`) as raw bytes — never via `console.*`,
 * so log capture tools that parse line-delimited JSON receive a clean stream.
 *
 * Honors the `LOG_LEVEL` env var (`debug` | `info` | `warn` | `error`,
 * default `info`). `error` level always emits regardless of `LOG_LEVEL`.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Resolve the active threshold from `LOG_LEVEL`, defaulting to `info`. */
function activeThreshold(): number {
  const raw = process.env["LOG_LEVEL"];
  if (raw === undefined) return LEVEL_ORDER.info;
  const lower = raw.toLowerCase();
  if (lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {
    return LEVEL_ORDER[lower];
  }
  return LEVEL_ORDER.info;
}

/**
 * Serialize a single log record. Caller-supplied fields override the
 * built-ins on key collision; that's intentional so handlers can rename
 * a noisy `msg` into a structured field if they want.
 */
function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  // `error` always emits; everything else is gated on the threshold.
  if (level !== "error" && LEVEL_ORDER[level] < activeThreshold()) return;

  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    // Fall back to a safe minimal record if `fields` contained a circular ref.
    line = `${JSON.stringify({ time: record["time"], level, msg, error: "log_serialize_failed" })}\n`;
  }
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(line);
}

/**
 * Singleton logger. Methods are bound to a fresh closure each call; safe to
 * destructure (`const { info } = logger`) without losing context.
 */
export const logger: {
  /** Verbose diagnostic log; suppressed unless `LOG_LEVEL=debug`. */
  debug(msg: string, fields?: Record<string, unknown>): void;
  /** Routine operational event. */
  info(msg: string, fields?: Record<string, unknown>): void;
  /** Recoverable problem worth attention. */
  warn(msg: string, fields?: Record<string, unknown>): void;
  /** Failure or unexpected condition; always emitted. */
  error(msg: string, fields?: Record<string, unknown>): void;
} = {
  debug(msg, fields) {
    emit("debug", msg, fields);
  },
  info(msg, fields) {
    emit("info", msg, fields);
  },
  warn(msg, fields) {
    emit("warn", msg, fields);
  },
  error(msg, fields) {
    emit("error", msg, fields);
  },
};
