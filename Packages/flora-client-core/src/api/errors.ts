export class ApiRequestError extends Error {
  readonly status: number;
  /** Stable machine-readable code from API JSON `code` / `Code`, when present. */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    if (code) this.code = code;
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

export type ParsedApiError = {
  message: string;
  code?: string;
};

type ApiErrorBody = {
  error?: string;
  Error?: string;
  code?: string;
  Code?: string;
  detail?: string;
  Detail?: string;
};

/** Parse Flora API error JSON (`error` / `code` + optional detail). */
export function parseApiErrorBody(data: unknown, status: number): ParsedApiError {
  const o = data && typeof data === "object" ? (data as ApiErrorBody) : {};
  const base =
    (typeof o.error === "string" && o.error) ||
    (typeof o.Error === "string" && o.Error) ||
    `Ошибка ${status}`;
  const detailRaw = o.detail ?? o.Detail;
  const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : "";
  const message = detail && !base.includes(detail) ? `${base} (${detail})` : base;
  const code =
    (typeof o.code === "string" && o.code.trim()) ||
    (typeof o.Code === "string" && o.Code.trim()) ||
    undefined;
  return code ? { message, code } : { message };
}

/** Shared API error text (`error` + optional `detail`/`Detail`). */
export async function parseApiErrorMessage(r: Response): Promise<string> {
  return (await parseApiError(r)).message;
}

export async function parseApiError(r: Response): Promise<ParsedApiError> {
  const data = await r.json().catch(() => ({}));
  return parseApiErrorBody(data, r.status);
}

export async function throwApiRequestError(r: Response): Promise<never> {
  const { message, code } = await parseApiError(r);
  throw new ApiRequestError(r.status, message, code);
}
