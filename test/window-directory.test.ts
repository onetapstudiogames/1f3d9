import test from 'node:test'
import assert from 'node:assert/strict'
import { readPublicDirectory, type PublicDirectoryQuery } from '../src/public-directory.ts'
import { publicWindowResidents } from '../src/window.ts'
import { searchWindowDirectory, WINDOW_JS } from '../src/window-client.ts'
import { PART_35_VIEW_RENDER_AND_SELECTION } from '../src/window-client/program/35-view-render-and-selection.ts'

test('retirement labels keep resident handles usable in reads and history links', async () => {
  const rows = ['retiring', 'retired'].map((retirement_state, index) => ({
    entry_type: 'resident', id: index + 7, handle: `resident-${index + 7}`,
    retirement_state, joined_at: '2026-08-11T00:00:00.000Z', current_place_id: 2,
  }))
  const directory = await readPublicDirectory(async (query) => {
    assert.match(query, /resident\.retirement_state/u)
    return rows
  })
  const residents = publicWindowResidents(rows)
  for (const [index, state] of ['retiring', 'retired'].entries()) {
    for (const resident of [directory.residents[index], residents[index]]) {
      assert.equal(resident?.handle, `resident-${index + 7}`)
      assert.equal(resident?.retirement_state, state)
      assert.equal(resident?.display_handle, `resident-${index + 7} (${state})`)
    }
  }
  const source = WINDOW_JS.slice(WINDOW_JS.indexOf('  function shownHandle('),
    WINDOW_JS.indexOf('  // Quiet first (#75)'))
  const label = new Function('handleIsMuted', 'MUTED_RESIDENT_LABEL', 'state', 'residentReference',
    source + '\nreturn shownHandle("resident-7")')
  const state = { snapshot: { residents } }
  assert.equal(label(() => false, 'muted', state, () => residents[0]), 'resident-7 (retiring)')
  assert.equal(label(() => true, 'muted', state, () => residents[0]), 'muted')
  assert.equal(label(() => false, 'muted', {
    ...state, directory: { residents: [{ handle: 'resident-7', retirement_state: 'retired' }] },
  }, () => residents[0]), 'resident-7 (retired)')
  const results = searchWindowDirectory([], directory.residents, 'resident-7')
  assert.equal(results[0]?.value, 'resident-7')
  assert.equal(results[0]?.label, 'resident-7 (retiring) · Resident #7')
})

test('directory names refresh repeatedly even when no public event changes', async () => {
  const source = PART_35_VIEW_RENDER_AND_SELECTION.slice(
    PART_35_VIEW_RENDER_AND_SELECTION.indexOf('  async function loadDirectory('))
  const callbacks: Array<() => void> = []
  let reads = 0
  const run = new Function('window', 'fetch', `
    let state = { directory: {}, snapshot: null, changeMarker: '1' }
    const REQUEST_TIMEOUT_MS = 10000
    const renderDirectoryStatus = () => {}, normalizeDirectory = value => value,
      renderAll = () => {}, ensureFocusedSelection = () => {}
    ${source}
    return loadDirectory(false)
  `)
  await run({ location: { origin: 'https://city.test' }, clearTimeout() {},
    setTimeout(callback: () => void, milliseconds: number) {
      if (milliseconds === 30_000) callbacks.push(callback)
      return 1
    } }, async () => { reads += 1; return { ok: true, json: async () => ({ residents: [], places: [] }) } })
  assert.equal(callbacks.length, 1)
  await callbacks.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2)
  assert.equal(callbacks.length, 1)
})

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

test('ordinary directory rows expose only drawing presence, never drawing or thumbnail data', async () => {
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
      has_drawing: true,
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
  assert.match(calls[0]?.text ?? '', /place\.retired_at\s+IS\s+NULL/iu)
  assert.doesNotMatch(
    calls[0]?.text ?? '',
    /\b(?:description|purpose|owner_id|secret_hash|model|joined_at|current_place_id|asleep)\b/iu,
  )
  assert.deepEqual(calls[0]?.params, ['[removed by maintainer]'])
  assert.deepEqual(Object.keys(directory).sort(), ['places', 'residents'])
  assert.deepEqual(
    Object.keys(directory.places[0] ?? {}).sort(),
    ['id', 'name', 'parent_id', 'quiet', 'type'],
  )
  assert.deepEqual(Object.keys(directory.residents[0] ?? {}).sort(), ['handle', 'has_drawing', 'id', 'type'])
  assert.doesNotMatch(JSON.stringify(directory), /"(?:drawing|thumb[^" ]*)"\s*:/iu)
  assert.deepEqual(directory, {
    places: [{ type: 'place', id: 2, parent_id: 1, name: '[removed by maintainer]', quiet: false }],
    residents: [{ type: 'resident', id: 7, handle: 'tiny-lantern', has_drawing: true }],
  })
})

test('the directory discloses a quiet place so every window listing can withhold its contents', async () => {
  const query: PublicDirectoryQuery = async () => [{
    entry_type: 'place', id: 42, parent_id: 1, name: 'Quiet porch', quiet: true,
  }, {
    entry_type: 'place', id: 43, parent_id: 1, name: 'Open square', quiet: false,
  }]

  const directory = await readPublicDirectory(query)

  assert.deepEqual(directory.places, [
    { type: 'place', id: 42, parent_id: 1, name: 'Quiet porch', quiet: true },
    { type: 'place', id: 43, parent_id: 1, name: 'Open square', quiet: false },
  ])
})
