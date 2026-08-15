import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const schema = read('../db/schema.sql')
const migrationsDirectory = new URL('../db/migrations/', import.meta.url)
const migrations = readdirSync(migrationsDirectory)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => read(`../db/migrations/${name}`))
  .join('\n')

test('things persist an owner-controlled open-to-use flag that defaults closed', () => {
  assert.match(
    schema,
    /\bopen_to_use\s+boolean\s+not\s+null\s+default\s+false\b/iu,
    'fresh databases must default every thing to closed use',
  )
  assert.match(
    migrations,
    /alter\s+table\s+(?:public\.)?things[\s\S]{0,300}\badd\s+column(?:\s+if\s+not\s+exists)?\s+open_to_use\s+boolean\s+not\s+null\s+default\s+false\b/iu,
    'existing databases need an additive, closed-by-default migration',
  )
})
