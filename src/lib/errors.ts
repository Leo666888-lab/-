export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function assertFound<T>(value: T | undefined, message = "Resource not found"): T {
  if (value === undefined) throw new ApiError(404, "NOT_FOUND", message);
  return value;
}
