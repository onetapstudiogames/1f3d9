import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DRAWING_BODY_MAX_BYTES,
  DRAWING_MAX_BYTES,
  DRAWING_PALETTE_MAX,
  parseDrawing,
  readBoundedJsonObject,
  type Drawing,
} from '../src/drawing.ts'

const emptySquares = (): null[] => Array.from({ length: 64 }, () => null)

function oneColourDrawing(colour = '#ad3f25'): Drawing {
  return Object.freeze({
    palette: Object.freeze([colour]),
    indices: Object.freeze([0, ...emptySquares().slice(1)]),
  })
}

test('drawing accepts exact palette-plus-indices shape and preserves blank versus unset', () => {
  const authored = parseDrawing(oneColourDrawing())
  assert.deepEqual(authored, { ok: true, drawing: oneColourDrawing() })

  const blank = Object.freeze({
    palette: Object.freeze([]),
    indices: Object.freeze(emptySquares()),
  })
  assert.deepEqual(parseDrawing(blank), { ok: true, drawing: blank })
  assert.deepEqual(parseDrawing(null), { ok: true, drawing: null })
  assert.notDeepEqual(parseDrawing(blank), parseDrawing(null))
})

test('drawing rejects unsafe colours, unknown fields, bad square counts, and bad indices', () => {
  const valid = oneColourDrawing()
  const invalid = [
    { ...valid, palette: ['red'] },
    { ...valid, palette: ['#AD3F25'] },
    { ...valid, palette: ['#ad3f25;display:none'] },
    { ...valid, indices: valid.indices.slice(0, 63) },
    { ...valid, indices: [...valid.indices.slice(0, 63), 1] },
    { ...valid, indices: [...valid.indices.slice(0, 63), -1] },
    { ...valid, indices: [...valid.indices.slice(0, 63), 0.5] },
    { ...valid, caption: 'not part of the drawing contract' },
    { palette: Array.from({ length: DRAWING_PALETTE_MAX + 1 }, () => '#ad3f25'), indices: valid.indices },
  ]

  for (const candidate of invalid) {
    const parsed = parseDrawing(candidate)
    assert.equal(parsed.ok, false, JSON.stringify(candidate))
    if (!parsed.ok) assert.match(parsed.error, /drawing/iu)
  }
})

test('drawing byte limit is measured from canonical UTF-8 JSON', () => {
  assert.equal(DRAWING_MAX_BYTES, 2_048)
  const valid = oneColourDrawing()
  const parsed = parseDrawing(valid)
  assert.equal(parsed.ok, true)
  assert.ok(Buffer.byteLength(JSON.stringify(valid), 'utf8') < DRAWING_MAX_BYTES)
})

test('bounded JSON reads actual UTF-8 bytes without trusting Content-Length', async () => {
  const body = JSON.stringify({ drawing: oneColourDrawing() })
  const noLength = new Request('https://1f3d9.com/api/me/drawing', {
    method: 'PATCH',
    body,
  })
  noLength.headers.delete('content-length')
  assert.deepEqual(await readBoundedJsonObject(noLength, DRAWING_BODY_MAX_BYTES), {
    ok: true,
    body: JSON.parse(body),
  })

  const multibyte = JSON.stringify({ drawing: null, padding: '🏮'.repeat(1_100) })
  assert.ok(multibyte.length < DRAWING_BODY_MAX_BYTES)
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > DRAWING_BODY_MAX_BYTES)
  const understated = new Request('https://1f3d9.com/api/me/drawing', {
    method: 'PATCH',
    headers: { 'content-length': '1' },
    body: multibyte,
  })
  const result = await readBoundedJsonObject(understated, DRAWING_BODY_MAX_BYTES)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /4096 UTF-8 bytes/iu)
})

test('bounded JSON distinguishes malformed input from an oversized body', async () => {
  const malformed = await readBoundedJsonObject(new Request('https://1f3d9.com/api/me/drawing', {
    method: 'PATCH', body: '{not json',
  }), DRAWING_BODY_MAX_BYTES)
  assert.deepEqual(malformed, { ok: false, error: 'body must be a JSON object' })

  const array = await readBoundedJsonObject(new Request('https://1f3d9.com/api/me/drawing', {
    method: 'PATCH', body: '[]',
  }), DRAWING_BODY_MAX_BYTES)
  assert.deepEqual(array, { ok: false, error: 'body must be a JSON object' })
})

test('bounded JSON stops reading and cancels an oversized stream', async () => {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(1_024))
      if (pulls === 100) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request('https://1f3d9.com/api/me/drawing', {
    method: 'PATCH',
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

  const result = await readBoundedJsonObject(request, DRAWING_BODY_MAX_BYTES)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /4096 UTF-8 bytes/iu)
  assert.equal(cancelled, true)
  assert.ok(pulls <= 6, `expected a bounded read, received ${pulls} chunks`)
})
