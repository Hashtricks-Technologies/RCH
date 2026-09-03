export type ErrorCode =
  | "validation" | "unauthenticated" | "forbidden" | "not_found" | "conflict"
  | "rule" | "rate_limited" | "not_ready" | "internal";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = new.target.name;
  }
  toEnvelope() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}
export class ValidationError extends AppError { constructor(message: string, details?: unknown) { super("validation", 400, message, details); } }
export class UnauthenticatedError extends AppError { constructor(message = "Sign in to continue.") { super("unauthenticated", 401, message); } }
export class ForbiddenError extends AppError { constructor(message: string) { super("forbidden", 403, message); } }
export class NotFoundError extends AppError { constructor(message: string) { super("not_found", 404, message); } }
export class ConflictError extends AppError { constructor(message: string, details?: unknown) { super("conflict", 409, message, details); } }
/** A domain rule refused the action. The message is what the operator reads. */
export class RuleError extends AppError { constructor(message: string, details?: unknown) { super("rule", 422, message, details); } }
export class RateLimitedError extends AppError { constructor(message = "Too many requests — wait a moment and try again.") { super("rate_limited", 429, message); } }
export class NotReadyError extends AppError { constructor(message: string) { super("not_ready", 503, message); } }
