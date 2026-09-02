// Ambient declaration for the test-only export from identity-client.mjs (a
// dependency-free CLI script, not part of the TypeScript build). Keep this
// signature in sync with storeSecret's real implementation.
export interface StoreSecretDeps {
  execFileSync?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown
  platform?: NodeJS.Platform
}

export declare function storeSecret(
  origin: string,
  label: string,
  payload: unknown,
  deps?: StoreSecretDeps,
): string
