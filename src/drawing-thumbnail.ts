import { deflateSync } from 'node:zlib'
import type { Drawing } from './drawing.ts'

export const DRAWING_THUMBNAIL_SIZE = 32

type PngChannels = 3 | 4

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.from(data)
  const chunk = Buffer.alloc(12 + body.length)
  chunk.writeUInt32BE(body.length, 0)
  typeBytes.copy(chunk, 4)
  body.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length)
  return chunk
}

export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: PngChannels,
): Uint8Array<ArrayBuffer> {
  if (
    !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
    pixels.length !== width * height * channels
  ) throw new Error('PNG dimensions do not match its pixels')

  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    const target = row * (stride + 1)
    raw[target] = 0
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), target + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array()),
  ]))
}

function rgb(hex: string): readonly [number, number, number] {
  return Object.freeze([
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ])
}

export function renderDrawingThumbnailPng(drawing: Drawing): Uint8Array<ArrayBuffer> {
  const scale = DRAWING_THUMBNAIL_SIZE / 8
  const colours = drawing.palette.map(rgb)
  const pixels = Buffer.alloc(DRAWING_THUMBNAIL_SIZE * DRAWING_THUMBNAIL_SIZE * 4)
  for (let targetY = 0; targetY < DRAWING_THUMBNAIL_SIZE; targetY += 1) {
    const sourceY = Math.floor(targetY / scale)
    for (let targetX = 0; targetX < DRAWING_THUMBNAIL_SIZE; targetX += 1) {
      const sourceX = Math.floor(targetX / scale)
      const paletteIndex = drawing.indices[sourceY * 8 + sourceX]
      if (paletteIndex === null) continue
      if (paletteIndex === undefined) throw new Error('drawing grid is incomplete')
      const colour = colours[paletteIndex]
      if (!colour) throw new Error('drawing grid references a missing colour')
      const offset = (targetY * DRAWING_THUMBNAIL_SIZE + targetX) * 4
      pixels[offset] = colour[0]
      pixels[offset + 1] = colour[1]
      pixels[offset + 2] = colour[2]
      pixels[offset + 3] = 255
    }
  }
  return encodePng(pixels, DRAWING_THUMBNAIL_SIZE, DRAWING_THUMBNAIL_SIZE, 4)
}
