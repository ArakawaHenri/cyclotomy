/** Keep protocol and presenter unions total when a new case is introduced. */
export function assertNever(value: never, description: string): never {
  throw new Error(`${description}: ${String(value)}`);
}
