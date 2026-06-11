/**
 * Shared query performance logger for SQLite repositories.
 * Logs queries that take longer than a threshold (default 10ms).
 */
export type QueryLogger = (method: string, start: number, note?: string) => void

export function createQueryLogger(label: string): QueryLogger {
  return (method: string, start: number, note?: string): void => {
    const elapsed = Date.now() - start
    if (elapsed > 10) {
      console.log(`[${label}.${method}] ${elapsed}ms${note ? ` - ${note}` : ''}`)
    }
  }
}
