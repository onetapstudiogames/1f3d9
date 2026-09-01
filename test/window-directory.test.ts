import test from 'node:test'
import assert from 'node:assert/strict'
import { readPublicDirectory, type PublicDirectoryQuery } from '../src/public-directory.ts'

test('the directory stays below 64 KiB at the live city scale', async () => {
  const rows = [
    ...Array.from({ length: 357 }, (_, index) => ({
      entry_type: 'place',
      id: index + 1,
      parent_id: index === 0 ? null : 1,
      name: index === 0 ? 'the world' : `District ${String(index + 1).padStart(3, '0')}`,
    })),
    ...Array.from({ length: 240 }, (_, index) => ({
      entry_type: 'resident',
      id: index + 1,
      parent_id: null,
      name: null,
      handle: `resident-${String(index + 1).padStart(3, '0')}`,
    })),
  ]
  const query: PublicDirectoryQuery = async () => rows

  const directory = await readPublicDirectory(query)
  const encoded = JSON.stringify({ view: 'directory', ...directory })

  assert.equal(directory.places.length, 357)
  assert.equal(directory.residents.length, 240)
  assert.ok(Buffer.byteLength(encoded, 'utf8') < 64 * 1024)
})

test('ordinary directory rows keep exact public keys and carry no drawing or thumbnail fields', async () => {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const query: PublicDirectoryQuery = async (text, params) => {
    calls.push({ text, params })
    return [{
      entry_type: 'place',
      id: 2,
      parent_id: 1,
      name: '[removed by maintainer]',
      description: 'private body',
      purpose: 'private purpose',
      owner_id: 7,
      current_place_id: 2,
      secret_hash: 'private hash',
      model: 'private model',
    }, {
      entry_type: 'resident',
      id: 7,
      parent_id: null,
      name: null,
      handle: 'tiny-lantern',
      joined_at: '2026-08-11T00:00:00.000Z',
      current_place_id: 2,
      asleep: false,
      secret_hash: 'private hash',
      model: 'private model',
    }]
  }

  const directory = await readPublicDirectory(query)

  assert.equal(calls.length, 1)
  assert.match(calls[0]?.text ?? '', /public:window-directory/iu)
  assert.match(calls[0]?.text ?? '', /moderation_actions/iu)
  assert.match(calls[0]?.text ?? '', /latest_moderation\.action\s*=\s*'remove'/iu)
  assert.doesNotMatch(
    calls[0]?.text ?? '',
    /\b(?:description|purpose|owner_id|secret_hash|model|joined_at|current_place_id|asleep)\b/iu,
  )
  assert.deepEqual(calls[0]?.params, ['[removed by maintainer]'])
  assert.deepEqual(Object.keys(directory).sort(), ['places', 'residents'])
  assert.deepEqual(Object.keys(directory.places[0] ?? {}).sort(), ['id', 'name', 'parent_id', 'type'])
  assert.deepEqual(Object.keys(directory.residents[0] ?? {}).sort(), ['handle', 'id', 'type'])
  assert.doesNotMatch(JSON.stringify(directory), /"(?:drawing[^" ]*|thumb[^" ]*)"\s*:/iu)
  assert.deepEqual(directory, {
    places: [{ type: 'place', id: 2, parent_id: 1, name: '[removed by maintainer]' }],
    residents: [{ type: 'resident', id: 7, handle: 'tiny-lantern' }],
  })
})
