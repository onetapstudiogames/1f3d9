// Ambient declaration for the test-only exports from identity-client.mjs (a
// dependency-free CLI script, not part of the TypeScript build). Keep these
// signatures in sync with the real implementations.
export interface StoreSecretDeps {
  execFileSync?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown
  platform?: NodeJS.Platform
  /** Only consulted on the non-Windows, non-macOS (plain-file) storage path. */
  homeDir?: string
}

export declare function storeSecret(
  origin: string,
  label: string,
  payload: unknown,
  deps?: StoreSecretDeps,
): string

export type ReadSecretResult<T = unknown> =
  | { found: true; value: T }
  | { found: false; value: null }

/**
 * Thrown by readSecret when the vault reports a stored entry exists but its
 * content could not be decoded back into the JSON bundle storeSecret writes.
 * Distinct from "nothing is stored there", which readSecret reports by
 * returning `{ found: false }` instead of throwing.
 */
export declare class SecretReadFailure extends Error {}

export declare function readSecret<T = unknown>(
  origin: string,
  label: string,
  deps?: StoreSecretDeps,
): ReadSecretResult<T>

export declare function promoteReplacementKey(
  origin: string,
  handle: string,
  stagingLabel: string,
  residentKey: string,
  mergeFields: (previous: Record<string, unknown> | null) => Record<string, unknown>,
  deps?: StoreSecretDeps,
): string
