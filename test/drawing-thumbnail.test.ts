import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import type { Drawing } from '../src/drawing.ts'
import {
  DRAWING_THUMBNAIL_SIZE,
  renderDrawingThumbnailPng,
} from '../src/drawing-thumbnail.ts'

const fixture: Drawing = Object.freeze({
  palette: Object.freeze(['#ff0000', '#00ff00', '#0000ff']),
  indices: Object.freeze([0, 1, null, 2, ...Array.from({ length: 60 }, () => null)]),
})

const blank: Drawing = Object.freeze({
  palette: Object.freeze([]),
  indices: Object.freeze(Array.from({ length: 64 }, () => null)),
})

function pngChunks(png: Uint8Array, requestedType: string): readonly Uint8Array[] {
  const chunks: Uint8Array[] = []
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let offset = 8
  while (offset < png.byteLength) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === requestedType) chunks.push(data)
    offset += 12 + length
  }
  return Object.freeze(chunks)
}

function inflatedPixels(png: Uint8Array): Uint8Array {
  const compressed = Buffer.concat(pngChunks(png, 'IDAT').map(chunk => Buffer.from(chunk)))
  return inflateSync(compressed)
}

test('thumbnail PNG is a deterministic 32x32 nearest-neighbour RGBA rendering', () => {
  const png = renderDrawingThumbnailPng(fixture)
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  assert.equal(DRAWING_THUMBNAIL_SIZE, 32)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(view.getUint32(16), 32)
  assert.equal(view.getUint32(20), 32)
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], 6, 'RGBA colour type')
  assert.equal(
    Buffer.from(png).toString('base64'),
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALElEQVR42u3OMQ4AIBACMP7/aVyNNzo42BJGEtKke0eGHpNLDjw/AAAAwPcWvX5foS4HRmkAAAAASUVORK5CYII=',
  )

  const pixels = inflatedPixels(png)
  assert.equal(pixels.length, 32 * (1 + 32 * 4))
  const firstRow = pixels.subarray(1, 1 + 32 * 4)
  assert.deepEqual([...firstRow.subarray(0, 4)], [255, 0, 0, 255])
  assert.deepEqual([...firstRow.subarray(12, 16)], [255, 0, 0, 255])
  assert.deepEqual([...firstRow.subarray(16, 20)], [0, 255, 0, 255])
  assert.deepEqual([...firstRow.subarray(28, 32)], [0, 255, 0, 255])
  assert.deepEqual([...firstRow.subarray(32, 36)], [0, 0, 0, 0])
  assert.deepEqual([...firstRow.subarray(48, 52)], [0, 0, 255, 255])
})

test('thumbnail PNG preserves a Complete all-transparent Blank as transparent pixels', () => {
  const png = renderDrawingThumbnailPng(blank)
  assert.equal(
    Buffer.from(png).toString('base64'),
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
  )

  const pixels = inflatedPixels(png)
  for (let row = 0; row < DRAWING_THUMBNAIL_SIZE; row += 1) {
    assert.equal(pixels[row * (1 + DRAWING_THUMBNAIL_SIZE * 4)], 0, 'PNG filter byte')
    for (let column = 0; column < DRAWING_THUMBNAIL_SIZE; column += 1) {
      assert.equal(
        pixels[row * (1 + DRAWING_THUMBNAIL_SIZE * 4) + 1 + column * 4 + 3],
        0,
        `alpha at ${column},${row}`,
      )
    }
  }
})
