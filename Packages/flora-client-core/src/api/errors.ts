export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export function isApiRequestError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError;
}

export function isUpgradeRequired(err: unknown): boolean {
  return isApiRequestError(err) && err.status === 426;
}

/** Fetch/network failure — not an HTTP error response from Flora.API. */
export function isNetworkError(err: unknown): boolean {
  if (isApiRequestError(err)) return false;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
