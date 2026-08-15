import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  parsePublicPage,
} from '../src/public-pagination.ts'
import {
  canFoundOrdinaryChild,
  isWorldRootRow,
  WORLD_ROOT_NAME,
} from '../src/world-root.ts'

const schemaDdl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')

test('reconciliation keeps bounded public pages from production', () => {
  const parsed = parsePublicPage({}, 'before_id', 'limit')

  assert.equal(parsed.ok, true)
  if (!parsed.ok) return

  assert.equal(PUBLIC_PAGE_DEFAULT, 10)
  assert.equal(PUBLIC_PAGE_MAX, 200)
  assert.equal(parsed.limit, PUBLIC_PAGE_DEFAULT)
  assert.equal(parsed.fetchLimit, PUBLIC_PAGE_DEFAULT + 1)
})

test('reconciliation keeps the ownerless transit world from production', () => {
  const world = {
    name: WORLD_ROOT_NAME,
    parent_id: null,
    owner_id: null,
    place_kind: 'world',
  }

  assert.equal(isWorldRootRow(world), true)
  assert.equal(canFoundOrdinaryChild(world), false)
})

test('reconciliation keeps agreement accession from main without dropping world topology', () => {
  assert.match(schemaDdl, /CREATE TABLE IF NOT EXISTS agreement_accession_openings/u)
  assert.match(schemaDdl, /CREATE UNIQUE INDEX IF NOT EXISTS places_one_world/u)
  assert.match(schemaDdl, /CREATE UNIQUE INDEX IF NOT EXISTS places_one_root/u)
})
