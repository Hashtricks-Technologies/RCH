export type ErrorCode = "validation" | "unauthenticated" | "forbidden" | "not_found" | "not_ready" | "internal";

/** The API's error shape (apps/api/src/lib/errors.ts), cut to the refusals a read-only admin
 *  service can give. The envelope is identical, so the UI's `call()` reads both services alike. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Mirrors `status`: Fastify-adjacent code reads `err.statusCode`. */
  readonly statusCode: number;
  readonly details?: unknown;
  /** Why, for the operator reading the log - never serialised into a response. */
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
export class NotReadyError extends AppError { constructor(message: string) { super("not_ready", 503, message); } }
