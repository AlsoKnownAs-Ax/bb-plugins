export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
