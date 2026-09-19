import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CiChangeScope = 'full' | 'internal-process'

export type ChangedEntry = Readonly<{
  status: string
  path: string
}>

const INTERNAL_PROCESS_DOCUMENTS = Object.freeze([
  'AGENTS.md',
  'docs/TESTING.md',
])

export function classifyChanges(changes: readonly ChangedEntry[]): CiChangeScope {
  if (changes.length === 0) return 'full'

  return changes.every(change => (
    change.status === 'M' && INTERNAL_PROCESS_DOCUMENTS.includes(change.path)
  ))
    ? 'internal-process'
    : 'full'
}

export function parseNullSeparatedChanges(input: Buffer): readonly ChangedEntry[] {
  if (input.length === 0) return []

  const tokens = input.toString('utf8').split('\0')
  if (tokens.at(-1) === '') tokens.pop()
  if (tokens.length % 2 !== 0) return [{ status: 'UNKNOWN', path: '' }]

  return Object.freeze(Array.from(
    { length: tokens.length / 2 },
    (_, index) => Object.freeze({
      status: tokens[index * 2] ?? 'UNKNOWN',
      path: tokens[index * 2 + 1] ?? '',
    }),
  ))
}

function readNullSeparatedChanges(): readonly ChangedEntry[] {
  const input = readFileSync(0)
  return parseNullSeparatedChanges(input)
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  console.log(`scope=${classifyChanges(readNullSeparatedChanges())}`)
}
