// Founder-operated manual administration using the operator's private database access.
// Never schedule this script. Reading the queue does not complete requests.
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { requireDirectPostgresUrl } from './database-target.ts'

type Database = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

function completionTarget(args: readonly string[]): number | null {
  if (args.length === 1 && args[0] === '--list') return null
  if (args.length === 2 && args[0] === '--complete' && /^[1-9][0-9]*$/u.test(args[1]!)
    && Number.isSafeInteger(Number(args[1]))) return Number(args[1])
  throw new Error('Usage: node --experimental-strip-types scripts/resident-retirements.ts --list | --complete <resident-number>')
}

export async function runResidentRetirements(db: Database, args: readonly string[]): Promise<unknown> {
  const target = completionTarget(args)
  if (target === null) {
    const result = await db.query(`SELECT id,handle,retirement_requested_at FROM residents
      WHERE retirement_state='retiring' AND retirement_requested_at + interval '30 days' <= clock_timestamp()
      ORDER BY retirement_requested_at,id LIMIT 100`)
    return { residents: result.rows, limit: 100, message: 'Complete each request manually, then list again for the next 100.' }
  }
  const result = await db.query('SELECT complete_resident_retirement(1,$1) AS completed', [target])
  return { resident_id: target, completed: result.rows[0]?.completed === true }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  completionTarget(args)
  const client = new Client({
    connectionString: requireDirectPostgresUrl(process.env.DATABASE_URL, 'DATABASE_URL'),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  })
  try {
    await client.connect()
    console.log(JSON.stringify(await runResidentRetirements(client, args)))
  } finally {
    await client.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Database errors can contain private connection information or row details.
    console.error('Retirement administration failed. Check the command, database access and 30-day hold; then list the queue before retrying.')
    process.exitCode = 1
  })
}
