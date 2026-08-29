import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DRAWING_BODY_MAX_BYTES,
  DRAWING_DESCRIPTION_MAX_BYTES,
  DRAWING_MAX_BYTES,
  DRAWING_PALETTE_MAX,
  DRAWING_VARIANTS_MAX,
  drawingPresentationState,
  drawingRows,
  parseDrawing,
  parseDrawingVariants,
  parseDrawingWrite,
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

test('drawing writes distinguish explicit clear, exact refusal, and explicitly staged pixels', () => {
  assert.deepEqual(parseDrawingWrite({ drawing: null }), {
    ok: true,
    value: { state: 'undrawn', description: null, drawing: null },
  })
  assert.deepEqual(parseDrawingWrite({
    drawing: 'REFUSE',
    drawing_description: 'I chose not to draw this.',
  }), {
    ok: true,
    value: {
      state: 'refused',
      description: 'I chose not to draw this.',
      drawing: null,
    },
  })
  assert.deepEqual(parseDrawingWrite({
    drawing: oneColourDrawing(),
    drawing_state: 'in_progress',
    drawing_description: 'The first lantern is placed.',
  }), {
    ok: true,
    value: {
      state: 'in_progress',
      description: 'The first lantern is placed.',
      drawing: oneColourDrawing(),
    },
  })
  assert.deepEqual(parseDrawingWrite({
    drawing: oneColourDrawing(),
    drawing_state: 'complete',
    drawing_description: 'REFUSE is ordinary description text here.',
  }), {
    ok: true,
    value: {
      state: 'complete',
      description: 'REFUSE is ordinary description text here.',
      drawing: oneColourDrawing(),
    },
  })

  const lowercaseRefusal = parseDrawingWrite({
    drawing: 'refuse',
    drawing_description: 'Only the exact whole value is the signal.',
  })
  assert.equal(lowercaseRefusal.ok, false)
  if (!lowercaseRefusal.ok) assert.match(lowercaseRefusal.error, /drawing.*null.*REFUSE.*object/iu)
})

test('drawing writes require the atomic state-description pairing without inferring intent', () => {
  const invalid = [
    [{ drawing: 'REFUSE' }, /drawing_description/iu],
    [{ drawing: oneColourDrawing(), drawing_state: 'complete' }, /drawing_description/iu],
    [{ drawing: oneColourDrawing(), drawing_description: 'Not enough.' }, /drawing_state/iu],
    [{ drawing: oneColourDrawing(), drawing_state: 'blank', drawing_description: '' }, /in_progress.*complete/iu],
    [{ drawing: null, drawing_state: 'complete' }, /undrawn.*drawing_state/iu],
    [{ drawing: null, drawing_description: '' }, /undrawn.*drawing_description/iu],
  ] as const

  for (const [candidate, expected] of invalid) {
    const parsed = parseDrawingWrite(candidate)
    assert.equal(parsed.ok, false, JSON.stringify(candidate))
    if (!parsed.ok) assert.match(parsed.error, expected)
  }
})

test('drawing descriptions are explicit, may be empty, and are bounded by UTF-8 bytes', () => {
  assert.equal(DRAWING_DESCRIPTION_MAX_BYTES, 280)
  const atLimit = '🏮'.repeat(70)
  const overLimit = `${atLimit}🏮`
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), DRAWING_DESCRIPTION_MAX_BYTES)

  for (const drawing_description of ['', atLimit]) {
    const parsed = parseDrawingWrite({
      drawing: oneColourDrawing(),
      drawing_state: 'complete',
      drawing_description,
    })
    assert.equal(parsed.ok, true, JSON.stringify(drawing_description))
  }

  const oversized = parseDrawingWrite({
    drawing: 'REFUSE',
    drawing_description: overLimit,
  })
  assert.equal(oversized.ok, false)
  if (!oversized.ok) assert.match(oversized.error, /drawing_description.*280 UTF-8 bytes/iu)
})

test('public drawing descriptions and variant names reject unsafe or credential-shaped text', () => {
  const unsafeText = [
    'control\u0001character',
    'right-to-left\u202Espoof',
    'replacement \uFFFD text',
    'caf\u00C3\u00A9 mojibake',
    `resident key 1f3d9_sk_${'a'.repeat(8)}`,
  ] as const

  for (const drawing_description of unsafeText) {
    const parsed = parseDrawingWrite({
      drawing: oneColourDrawing(),
      drawing_state: 'complete',
      drawing_description,
    })
    assert.equal(parsed.ok, false, drawing_description)
    if (!parsed.ok) assert.match(parsed.error, /drawing_description.*safe public text/iu)
  }

  for (const name of [...unsafeText, 'two\nlines']) {
    const parsed = parseDrawingVariants([{
      name,
      drawing: oneColourDrawing(),
      drawing_state: 'complete',
      drawing_description: '',
    }])
    assert.equal(parsed.ok, false, JSON.stringify(name))
    if (!parsed.ok) assert.match(parsed.error, /variant name.*safe one-line/iu)
  }

  const normalized = parseDrawingVariants([{
    name: '  evening lamp  ',
    drawing: oneColourDrawing(),
    drawing_state: 'complete',
    drawing_description: 'Owner words remain exact.\nA second safe line.',
  }])
  assert.equal(normalized.ok, true)
  if (normalized.ok) {
    assert.equal(normalized.variants[0]?.name, 'evening lamp')
    assert.equal(normalized.variants[0]?.description, 'Owner words remain exact.\nA second safe line.')
  }
})

test('presentation state makes blank a complete transparent drawing, never a pixel inference', () => {
  const transparent: Drawing = Object.freeze({
    palette: Object.freeze([]),
    indices: Object.freeze(emptySquares()),
  })

  assert.equal(drawingPresentationState({ state: 'undrawn', drawing: null }), 'undrawn')
  assert.equal(drawingPresentationState({ state: 'refused', drawing: null }), 'refused')
  assert.equal(drawingPresentationState({ state: 'in_progress', drawing: transparent }), 'in_progress')
  assert.equal(drawingPresentationState({ state: 'complete', drawing: transparent }), 'blank')
  assert.equal(drawingPresentationState({ state: 'complete', drawing: oneColourDrawing() }), 'complete')
})

test('canonical drawing rows are eight exact human-comparable palette-index rows', () => {
  const drawing: Drawing = Object.freeze({
    palette: Object.freeze(Array.from({ length: 12 }, (_, index) => `#0000${index.toString(16).padStart(2, '0')}`)),
    indices: Object.freeze([
      0, 10, null, 1, null, 11, 2, null,
      ...Array.from({ length: 56 }, () => null),
    ]),
  })

  const rows = drawingRows(drawing)
  assert.deepEqual(rows, [
    '0 10 . 1 . 11 2 .',
    '. . . . . . . .',
    '. . . . . . . .',
    '. . . . . . . .',
    '. . . . . . . .',
    '. . . . . . . .',
    '. . . . . . . .',
    '. . . . . . . .',
  ])
  assert.equal(Object.isFrozen(rows), true)
  for (const row of rows) assert.equal(row.split(' ').length, 8)
})

test('kind drawing variants are bounded, exact-name unique, described drawings', () => {
  assert.equal(DRAWING_VARIANTS_MAX, 8)
  const variants = Array.from({ length: DRAWING_VARIANTS_MAX }, (_, index) => ({
    name: index === 0 ? '🏮'.repeat(16) : `variant-${index}`,
    drawing: oneColourDrawing(`#0000${index.toString(16).padStart(2, '0')}`),
    drawing_state: index % 2 === 0 ? 'complete' : 'in_progress',
    drawing_description: index === 0 ? '' : `Owner variation ${index}.`,
  }))
  const parsed = parseDrawingVariants(variants)
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.variants.length, DRAWING_VARIANTS_MAX)
    assert.deepEqual(parsed.variants[0], {
      name: '🏮'.repeat(16),
      state: 'complete',
      description: '',
      drawing: oneColourDrawing('#000000'),
    })
    assert.equal(Object.isFrozen(parsed.variants), true)
    assert.equal(Object.isFrozen(parsed.variants[0]), true)
  }

  const caseSensitiveNames = parseDrawingVariants([
    { ...variants[1], name: 'day' },
    { ...variants[2], name: 'Day' },
  ])
  assert.equal(caseSensitiveNames.ok, true)
})

test('kind drawing variants reject overflow, exact duplicate names, and incomplete entries', () => {
  const valid = {
    name: 'day',
    drawing: oneColourDrawing(),
    drawing_state: 'complete',
    drawing_description: '',
  } as const
  const invalid = [
    [Array.from({ length: DRAWING_VARIANTS_MAX + 1 }, (_, index) => ({ ...valid, name: `v${index}` })), /at most 8/iu],
    [[valid, { ...valid }], /unique.*name/iu],
    [[{ ...valid, name: '' }], /name.*1.*64 UTF-8 bytes/iu],
    [[{ ...valid, name: '🏮'.repeat(17) }], /name.*1.*64 UTF-8 bytes/iu],
    [[{ name: 'missing-state', drawing: valid.drawing, drawing_description: '' }], /drawing_state/iu],
    [[{ name: 'missing-description', drawing: valid.drawing, drawing_state: 'complete' }], /drawing_description/iu],
    [[{ ...valid, drawing: 'REFUSE' }], /drawing.*object/iu],
  ] as const

  for (const [candidate, expected] of invalid) {
    const parsed = parseDrawingVariants(candidate)
    assert.equal(parsed.ok, false, JSON.stringify(candidate))
    if (!parsed.ok) assert.match(parsed.error, expected)
  }
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

test('bounded JSON refuses an oversized body with its bound named', async () => {
  // The framework read is the only request-body read that resolves on
  // Vercel's Node bridge (the PR #115 class), so the bound is enforced on
  // the actual bytes after the read rather than by early stream cancel;
  // the platform itself caps request bodies well above this limit.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 100; i += 1) controller.enqueue(new Uint8Array(1_024))
      controller.close()
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
})
