export function parseRestoreArgs(argv: string[]): { handle: string; confirmed: boolean }
export function sanitizeHandleForFilename(handle: string): string
export function buildKeyFilePath(options: {
  backupsDir: string
  handle: string
  now: Date
  nonce: string
}): string
export function writeSecretFileExclusive(path: string, secret: string): Promise<void>
export function restoreResidentKey(options: {
  handle: string
  confirmed?: boolean
  database: {
    query(text: string, values?: unknown[]): Promise<unknown[] | { rows: unknown[] }>
  }
  backupsDir: string
  makeSecret?: () => string
  makeNonce?: (attempt: number) => string
  now?: () => Date
  log?: (line: string) => void
}): Promise<
  | { rotated: false; residentId: number }
  | { rotated: true; residentId: number; keyPath: string }
>
export function restoreKeyMain(
  argv?: string[],
  dependencies?: {
    root?: string
    environment?: NodeJS.ProcessEnv
    connect?: (databaseUrl: string) => Promise<{ query(text: string, values?: unknown[]): Promise<unknown[] | { rows: unknown[] }> }>
    rotation?: {
      makeSecret?: () => string
      makeNonce?: (attempt: number) => string
      now?: () => Date
      log?: (line: string) => void
    }
  },
): Promise<
  | { rotated: false; residentId: number }
  | { rotated: true; residentId: number; keyPath: string }
>
