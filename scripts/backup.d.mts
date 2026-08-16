export function parseBackupArgs(argv: string[]): { out: string | undefined; keep: number }
export function quoteSqlIdentifier(identifier: string): string
export function shouldPruneBackups(options: { out: string | undefined; keep: number }): boolean
export function fullTimestamp(date: Date): string
export function safeDisplay(value: unknown): string
export function parseEnvText(text: string): Record<string, string>
export function resolveDatabaseUrl(root?: string, environment?: NodeJS.ProcessEnv): string
export function writeJsonAtomic(
  outputPath: string,
  json: string,
  dependencies?: { makeTempPath?: (outputPath: string) => string },
): Promise<void>
export function runBackup(options: {
  options: { out: string | undefined; keep: number }
  root?: string
  cwd?: string
  environment?: NodeJS.ProcessEnv
  connect?: (databaseUrl: string) => Promise<{ query(text: string): Promise<unknown[] | { rows: unknown[] }> }>
  now?: () => Date
  log?: (line: string) => void
}): Promise<{
  outputPath: string
  tables: number
  rows: number
  retention: { kept: number; pruned: number; skipped: boolean }
}>
export function backupMain(
  argv?: string[],
  dependencies?: {
    root?: string
    cwd?: string
    environment?: NodeJS.ProcessEnv
    connect?: (databaseUrl: string) => Promise<{ query(text: string): Promise<unknown[] | { rows: unknown[] }> }>
    now?: () => Date
    log?: (line: string) => void
  },
): Promise<{
  outputPath: string
  tables: number
  rows: number
  retention: { kept: number; pruned: number; skipped: boolean }
}>
