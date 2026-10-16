/**
 * Typed error classes for cloud API operations.
 */

/** Authentication failure (401, expired token, revoked or inactive device) */
export class CloudAuthError extends Error {
  /** HTTP status of the rejected request, when the failure came from a response. */
  readonly status?: number;
  /** Machine-readable failure code from the server, when it sent one. */
  readonly code?: string;

  constructor(message: string, details?: { status?: number; code?: string }) {
    super(message);
    this.name = "CloudAuthError";
    this.status = details?.status;
    this.code = details?.code;
  }
}

/** Network-level failure (timeout, DNS, connection refused) */
export class CloudNetworkError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "CloudNetworkError";
    this.cause = cause;
  }
}

/** Server returned a non-2xx response */
export class CloudApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.body = body;
  }
}
