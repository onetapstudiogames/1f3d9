import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import * as ts from 'typescript'

// Postgres refuses to prepare a statement whose parameter it cannot type
// (error 42P18), and a placeholder that the SQL never references has no type.
// The fake database in the unit tests never notices; production did, on the
// first real world-aisle claim (2026-09-04). This scans every static
// query(sql, [...]) pair in src and requires every $1..$n to be referenced.
// Statements built from interpolated fragments are skipped: their placeholders
// live in the fragments. Spread parameter arrays do not have a static length.
const SRC = join(process.cwd(), 'src')
const files = readdirSync(SRC).filter(name => name.endsWith('.ts'))

type QueryPair = Readonly<{ sql: string; count: number; line: number }>

function staticQueries(source: string, name: string): readonly QueryPair[] {
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let pairs: readonly QueryPair[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression
      const query = ts.isIdentifier(callee) ? callee.text === 'query'
        : ts.isPropertyAccessExpression(callee) && callee.name.text === 'query'
      const [sql, params] = node.arguments
      if (query && sql && (ts.isNoSubstitutionTemplateLiteral(sql) || ts.isStringLiteral(sql))
        && params && ts.isArrayLiteralExpression(params)
        && !params.elements.some(ts.isSpreadElement)) {
        pairs = [...pairs, {
          sql: sql.text,
          count: params.elements.length,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        }]
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return pairs
}

function parameterProblems(source: string, name: string): Readonly<{ checked: number; problems: readonly string[] }> {
  const queries = staticQueries(source, name)
  const problems = queries.flatMap(({ sql, count, line }) => {
    const used = new Set([...sql.matchAll(/\$(\d+)/gu)].map(hit => Number(hit[1])))
    const missing = Array.from({ length: count }, (_, index) => index + 1)
      .filter(index => !used.has(index))
      .map(index => `${name}:${line} never references $${index} of ${count}`)
    const extra = [...used].filter(index => index > count)
      .map(index => `${name}:${line} references $${index} but is given ${count}`)
    return [...missing, ...extra]
  })
  return { checked: queries.length, problems }
}

test('SQL parameter counting keeps nested commas inside one array element', () => {
  const source = 'database.query(`SELECT $1, $2`, [requestId, JSON.stringify({ request_hash: hash, result })])'
  assert.deepEqual(parameterProblems(source, 'fixture.ts'), { checked: 1, problems: [] })
})

test('SQL parameter counting still reports a supplied parameter the statement never uses', () => {
  const source = 'database.query(`SELECT $2`, [requestId, JSON.stringify({ request_hash: hash, result })])'
  assert.deepEqual(parameterProblems(source, 'fixture.ts'), {
    checked: 1,
    problems: ['fixture.ts:1 never references $1 of 2'],
  })
})

test('SQL parameter counting handles nested arrays, calls, comments and quoted commas', () => {
  const source = 'database.query!("SELECT $1, $2, $3", [[1, 2], choose("a,b", other), /* one */ { result }])'
  assert.deepEqual(parameterProblems(source, 'fixture.ts'), { checked: 1, problems: [] })
})

test('SQL parameter counting reports a placeholder with no supplied value', () => {
  const source = 'database.query("SELECT $1", [])'
  assert.deepEqual(parameterProblems(source, 'fixture.ts'), {
    checked: 1,
    problems: ['fixture.ts:1 references $1 but is given 0'],
  })
})

test('SQL parameter counting leaves interpolated SQL and dynamic array lengths to their callers', () => {
  const source = 'database.query(`SELECT ${columns}`, [first]); database.query("SELECT $1", [...values])'
  assert.deepEqual(parameterProblems(source, 'fixture.ts'), { checked: 0, problems: [] })
})

test('every static SQL statement references every parameter it is given', () => {
  const problems: string[] = []
  let checked = 0
  for (const name of files) {
    const source = readFileSync(join(SRC, name), 'utf8')
    const result = parameterProblems(source, name)
    checked += result.checked
    problems.push(...result.problems)
  }
  assert.ok(checked > 20, `expected to check many statements, checked ${checked}`)
  assert.deepEqual(problems, [])
})
