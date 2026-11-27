export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function assert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}
