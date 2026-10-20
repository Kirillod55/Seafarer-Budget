// Generates the PWA icons into public/icons/ with no dependencies:
// a white ship's wheel on the app's accent blue, rasterised pixel by pixel
// (3x3 supersampling) and encoded as PNG with node:zlib.
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url))
const BG = [0x1f, 0x6f, 0xeb] // --accent in styles.css
const FG = [0xff, 0xff, 0xff]
const SPOKES = 8
const SS = 3

/** Is the point (x, y) — wheel units, handle tips at distance 1 — painted white? */
function wheel(x, y) {
  const d = Math.hypot(x, y)
  if (Math.abs(d - 0.62) < 0.075) return true // rim
  if (d < 0.17 && d > 0.07) return true // hub with a hole
  for (let i = 0; i < SPOKES; i++) {
    const a = (i * 2 * Math.PI) / SPOKES
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    const along = x * ux + y * uy
    const across = Math.abs(x * uy - y * ux)
    if (along > 0.1 && along < 0.93 && across < 0.035) return true // spoke
    if (Math.hypot(x - 0.93 * ux, y - 0.93 * uy) < 0.075) return true // handle knob
  }
  return false
}

/** Signed "inside" test of a rounded square covering the whole canvas (coords in -1..1). */
function inRoundedSquare(x, y, r) {
  const qx = Math.abs(x) - (1 - r)
  const qy = Math.abs(y) - (1 - r)
  if (qx <= 0 || qy <= 0) return true
  return Math.hypot(qx, qy) <= r
}

/**
 * @param size   pixels
 * @param opts.corner  corner radius (0..1 of half-size); 0 = full-bleed square
 * @param opts.scale   wheel size relative to the canvas half-size
 */
function render(size, { corner, scale }) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1)
    raw[row] = 0 // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1
          if (!inRoundedSquare(x, y, corner)) continue
          const c = wheel(x / scale, y / scale) ? FG : BG
          r += c[0]
          g += c[1]
          b += c[2]
          a += 1
        }
      }
      const o = row + 1 + px * 4
      if (a > 0) {
        raw[o] = Math.round(r / a)
        raw[o + 1] = Math.round(g / a)
        raw[o + 2] = Math.round(b / a)
      }
      raw[o + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return encodePng(size, size, raw)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// "any" icons: rounded, wheel fills most of the canvas.
// maskable + apple-touch: full-bleed (the OS applies its own mask), wheel kept inside the 80% safe zone.
const ICONS = [
  ['icon-192.png', 192, { corner: 0.22, scale: 0.84 }],
  ['icon-512.png', 512, { corner: 0.22, scale: 0.84 }],
  ['icon-maskable-512.png', 512, { corner: 0, scale: 0.76 }],
  ['apple-touch-icon.png', 180, { corner: 0, scale: 0.8 }],
]

mkdirSync(OUT, { recursive: true })
for (const [name, size, opts] of ICONS) {
  writeFileSync(OUT + name, render(size, opts))
  console.log('wrote', name)
}
