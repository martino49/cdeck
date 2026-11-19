import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'build', 'assets')

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw[p++] = pixels[i]
      raw[p++] = pixels[i + 1]
      raw[p++] = pixels[i + 2]
      raw[p++] = pixels[i + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const ACCENT = [79, 140, 255]
const WHITE = [232, 234, 240]

function roundedRectMask(x, y, w, h, r) {
  return (px, py) => {
    if (px < x || px >= x + w || py < y || py >= y + h) return false
    const cx = Math.min(Math.max(px, x + r), x + w - 1 - r)
    const cy = Math.min(Math.max(py, y + r), y + h - 1 - r)
    const dx = px - cx
    const dy = py - cy
    return dx * dx + dy * dy <= (r + 0.5) * (r + 0.5)
  }
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const s = size / 32
  const body = roundedRectMask(7 * s, 2.5 * s, 18 * s, 27 * s, 3 * s)
  const screen = roundedRectMask(9.5 * s, 6 * s, 13 * s, 20 * s, 1.5 * s)
  const notch = (px, py) => py > 4 * s && py < 5.2 * s && px > 13.5 * s && px < 18.5 * s
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = body(x, y)
      const r = inside ? WHITE : ACCENT
      pixels[i] = r[0]
      pixels[i + 1] = r[1]
      pixels[i + 2] = r[2]
      pixels[i + 3] = 255
      if (inside) {
        if (screen(x, y)) {
          pixels[i] = ACCENT[0]
          pixels[i + 1] = ACCENT[1]
          pixels[i + 2] = ACCENT[2]
        } else if (notch(x, y)) {
          pixels[i] = ACCENT[0]
          pixels[i + 1] = ACCENT[1]
          pixels[i + 2] = ACCENT[2]
        }
      }
    }
  }
  return pixels
}

function icoEntry(size, pixels) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4
      const dst = (y * size + x) * 4
      xor[dst] = pixels[src + 2]
      xor[dst + 1] = pixels[src + 1]
      xor[dst + 2] = pixels[src]
      xor[dst + 3] = pixels[src + 3]
    }
  }
  const maskRowBytes = Math.ceil(size / 8 / 4) * 4 || 4
  const and = Buffer.alloc(maskRowBytes * size)
  return Buffer.concat([header, xor, and])
}

function buildIco(sizes) {
  const images = sizes.map((s) => ({ size: s, pixels: render(s) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const dir = Buffer.alloc(16 * images.length)
  images.forEach((img, i) => {
    const data = icoEntry(img.size, img.pixels)
    const e = i * 16
    dir[e] = img.size === 256 ? 0 : img.size
    dir[e + 1] = img.size === 256 ? 0 : img.size
    dir[e + 2] = 0
    dir[e + 3] = 0
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...images.map((img) => icoEntry(img.size, img.pixels))])
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'tray.ico'), buildIco([16, 24, 32]))
writeFileSync(join(outDir, 'icon.png'), png(256, 256, render(256)))
writeFileSync(join(outDir, 'icon.ico'), buildIco([16, 24, 32, 48, 256]))

console.log('icons written to', outDir)
