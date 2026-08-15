import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

interface SqlCall {
  readonly body: string
  readonly bodyOffset: number
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return typescriptFiles(target)
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : []
  }))
  return nested.flat()
}

function jsonObjectCalls(source: string): SqlCall[] {
  const calls: SqlCall[] = []
  const callPattern = /\bjsonb_build_object\s*\(/gi
  for (const match of source.matchAll(callPattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(')
    let depth = 1
    let quote: "'" | '"' | null = null
    for (let index = open + 1; index < source.length; index += 1) {
      const character = source[index]
      if (quote) {
        if (character === quote) {
          if (source[index + 1] === quote) index += 1
          else quote = null
        }
        continue
      }
      if (character === "'" || character === '"') {
        quote = character
      } else if (character === '(') {
        depth += 1
      } else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push({ body: source.slice(open + 1, index), bodyOffset: open + 1 })
          break
        }
      }
    }
  }
  return calls
}

function interpolationEnd(source: string, start: number): number {
  let depth = 1
  let quote: "'" | '"' | '`' | null = null
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return source.length
}

function hasExplicitCast(body: string, start: number, end: number): boolean {
  const after = body.slice(end)
  if (/^\s*::\s*[a-z_][a-z0-9_.]*(?:\s*\[\s*\])?/i.test(after)) return true
  return /\bcast\s*\(\s*$/i.test(body.slice(0, start))
    && /^\s+as\s+[a-z_][a-z0-9_.]*(?:\s*\[\s*\])?/i.test(after)
}

function bareParameters(call: SqlCall): Array<{ offset: number; token: string }> {
  const bare: Array<{ offset: number; token: string }> = []
  let quote: "'" | '"' | null = null
  for (let index = 0; index < call.body.length; index += 1) {
    const character = call.body[index]
    if (quote) {
      if (character === quote) {
        if (call.body[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character !== '$') continue

    if (call.body[index + 1] === '{') {
      const end = interpolationEnd(call.body, index)
      if (!hasExplicitCast(call.body, index, end)) {
        bare.push({ offset: index, token: call.body.slice(index, end) })
      }
      index = end - 1
      continue
    }

    const positional = call.body.slice(index).match(/^\$\d+\b/)
    if (!positional) continue
    const end = index + positional[0].length
    if (!hasExplicitCast(call.body, index, end)) {
      bare.push({ offset: index, token: positional[0] })
    }
    index = end - 1
  }
  return bare
}

test('jsonb_build_object parameters always declare their PostgreSQL type', async () => {
  const sourceRoots = ['api', 'scripts', 'src'].map(directory => path.resolve(directory))
  const failures: string[] = []
  for (const sourceRoot of sourceRoots) {
    for (const file of await typescriptFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const call of jsonObjectCalls(source)) {
        for (const parameter of bareParameters(call)) {
          const offset = call.bodyOffset + parameter.offset
          const line = source.slice(0, offset).split('\n').length
          failures.push(`${path.relative(process.cwd(), file).replaceAll('\\', '/')}:${line} ${parameter.token}`)
        }
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `Bare parameters inside jsonb_build_object are ambiguous in PostgreSQL:\n${failures.join('\n')}`,
  )
})
