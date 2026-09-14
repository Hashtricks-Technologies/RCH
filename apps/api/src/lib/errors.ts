export type ErrorCode =
  | "validation" | "unauthenticated" | "forbidden" | "not_found" | "conflict"
  | "rule" | "rate_limited" | "not_ready" | "internal";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Mirrors `status`. Fastify-adjacent code (plugins, error handlers upstream of ours)
   *  reads `err.statusCode`, not `err.status` — keep both in sync. */
  readonly statusCode: number;
  readonly details?: unknown;
  /** Why, for the operator reading the log — never for the caller. A login is refused with one
   *  sentence whether the id is unknown, the password wrong or the account deactivated, and
   *  this is where the difference goes: onto the request's own log line (`plugins/logging.ts`),
   *  and nowhere in `toEnvelope()`. */
  override readonly cause?: string;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown, cause?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
    this.cause = cause;
    this.name = new.target.name;
  }
  toEnvelope() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}
export class ValidationError extends AppError { constructor(message: string, details?: unknown) { super("validation", 400, message, details); } }
export class UnauthenticatedError extends AppError { constructor(message = "Sign in to continue.", cause?: string) { super("unauthenticated", 401, message, undefined, cause); } }
export class ForbiddenError extends AppError { constructor(message: string) { super("forbidden", 403, message); } }
export class NotFoundError extends AppError { constructor(message: string) { super("not_found", 404, message); } }
export class ConflictError extends AppError { constructor(message: string, details?: unknown) { super("conflict", 409, message, details); } }
/**
 * A domain rule refused the action. The message is what the operator reads.
 * @public — consumed by Phase 2 write endpoints.
 */
export class RuleError extends AppError { constructor(message: string, details?: unknown) { super("rule", 422, message, details); } }
export class RateLimitedError extends AppError { constructor(message = "Too many requests — wait a moment and try again.") { super("rate_limited", 429, message); } }
export class NotReadyError extends AppError { constructor(message: string) { super("not_ready", 503, message); } }
