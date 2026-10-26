// Generates the app icons with no dependencies: a dark anchor on a lime tile —
// the same mark as the logo in the PC sidebar (34 px tile, 11 px corners, 20 px anchor).
// Rasterised pixel by pixel (4x4 supersampling) and encoded as PNG with node:zlib;
// the Windows .ico and macOS .icns simply wrap those PNGs.
//   public/icons/      — PWA (manifest) and iPhone «На экран Домой»
//   src-tauri/icons/   — the Windows program (Tauri bundle)
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PWA = fileURLToPath(new URL('../public/icons/', import.meta.url))
const TAURI = fileURLToPath(new URL('../src-tauri/icons/', import.meta.url))
const BG = [0xc6, 0xf4, 0x32] // --accent (lime)
const FG = [0x11, 0x14, 0x0a] // --on-accent
const SS = 4

// The anchor from the sidebar, in its 24-unit viewBox:
// <circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 12H3a9 9 0 0 0 18 0h-2"/>, stroke 2.2, round caps.
const HALF = 2.2 / 2
function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
/** Is the point (x, y) in viewBox units painted? */
function anchor(x, y) {
  if (Math.abs(Math.hypot(x - 12, y - 5) - 2) <= HALF) return true // ring
  if (distToSegment(x, y, 12, 7, 12, 21) <= HALF) return true // shank
  if (distToSegment(x, y, 5, 12, 3, 12) <= HALF) return true // left fluke tip
  if (distToSegment(x, y, 21, 12, 19, 12) <= HALF) return true // right fluke tip
  if (y >= 12 && Math.abs(Math.hypot(x - 12, y - 12) - 9) <= HALF) return true // arms (lower half circle)
  return false
}

/** Inside a rounded square covering the whole canvas (coords in -1..1, r = corner / half-size). */
function inRoundedSquare(x, y, r) {
  const qx = Math.abs(x) - (1 - r)
  const qy = Math.abs(y) - (1 - r)
  if (qx <= 0 || qy <= 0) return true
  return Math.hypot(qx, qy) <= r
}

// Sidebar proportions: corner 11/34 of the side, the 24-unit anchor box drawn 20/34 of the side.
const CORNER = 11 / 17
const GLYPH = 20 / 34

/**
 * @param size   pixels
 * @param opts.corner  corner radius (0..1 of half-size); 0 = full-bleed square (the OS applies its own mask)
 */
function pixels(size, { corner }) {
  const rgba = Buffer.alloc(size * size * 4)
  const box = size * GLYPH // anchor viewBox size in pixels
  const off = (size - box) / 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS
          const fy = py + (sy + 0.5) / SS
          if (!inRoundedSquare((fx / size) * 2 - 1, (fy / size) * 2 - 1, corner)) continue
          const c = anchor(((fx - off) / box) * 24, ((fy - off) / box) * 24) ? FG : BG
          r += c[0]
          g += c[1]
          b += c[2]
          a += 1
        }
      }
      const o = (py * size + px) * 4
      if (a > 0) {
        rgba[o] = Math.round(r / a)
        rgba[o + 1] = Math.round(g / a)
        rgba[o + 2] = Math.round(b / a)
      }
      rgba[o + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return rgba
}
const render = (size, opts) => encodePng(size, size, pixels(size, opts))

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
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1)) // each row starts with filter byte 0
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
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

/** 32-bit BMP (DIB) image for an .ico entry: bottom-up BGRA plus an empty AND mask. */
function encodeDib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size)
  out.writeUInt32LE(40, 0) // BITMAPINFOHEADER
  out.writeInt32LE(size, 4)
  out.writeInt32LE(size * 2, 8) // colour + mask
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const d = 40 + ((size - 1 - y) * size + x) * 4
      out[d] = rgba[s + 2]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s]
      out[d + 3] = rgba[s + 3]
    }
  }
  return out
}

/** Windows .ico: classic BMP entries for the small sizes, PNG for 256 (the standard layout). */
function encodeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  const pngs = images.map(([size, rgba]) => [size, size >= 256 ? encodePng(size, size, rgba) : encodeDib(size, rgba)])
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i
    head[e] = size >= 256 ? 0 : size // 0 means 256
    head[e + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, e + 4) // colour planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(png.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...pngs.map(([, png]) => png)])
}

/** macOS .icns holding PNG images (Tauri requires the file in its icon list). */
function encodeIcns(entries) {
  const parts = entries.map(([type, png]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([h, png])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

const rounded = { corner: CORNER }
const fullBleed = { corner: 0 }

// PWA: "any" icons are rounded like the sidebar logo; maskable and apple-touch are full-bleed
// (Android and iOS cut their own shape), the anchor stays well inside the 80% safe zone.
const PWA_ICONS = [
  ['icon-192.png', 192, rounded],
  ['icon-512.png', 512, rounded],
  ['icon-maskable-512.png', 512, fullBleed],
  ['apple-touch-icon.png', 180, fullBleed],
]
mkdirSync(PWA, { recursive: true })
for (const [name, size, opts] of PWA_ICONS) {
  writeFileSync(PWA + name, render(size, opts))
  console.log('wrote public/icons/' + name)
}

// Windows program (Tauri): rounded tile on a transparent background, like the sidebar logo.
const px = Object.fromEntries([16, 24, 32, 48, 64, 128, 256, 512, 1024].map((s) => [s, pixels(s, rounded)]))
const png = Object.fromEntries(Object.entries(px).map(([s, rgba]) => [s, encodePng(+s, +s, rgba)]))
mkdirSync(TAURI, { recursive: true })
const TAURI_FILES = [
  ['32x32.png', png[32]],
  ['128x128.png', png[128]],
  ['128x128@2x.png', png[256]],
  ['icon.png', png[512]],
  ['icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256].map((s) => [s, px[s]]))],
  ['icon.icns', encodeIcns([['icp4', png[16]], ['icp5', png[32]], ['ic07', png[128]], ['ic08', png[256]], ['ic09', png[512]], ['ic10', png[1024]]])],
]
for (const [name, data] of TAURI_FILES) {
  writeFileSync(TAURI + name, data)
  console.log('wrote src-tauri/icons/' + name)
}

// Telegram bot avatar (set by hand in @BotFather → /setuserpic): full-bleed, Telegram crops it to a circle and the
// anchor stays inside it.
const BOT = fileURLToPath(new URL('../docs/design/', import.meta.url))
mkdirSync(BOT, { recursive: true })
writeFileSync(BOT + 'bot-avatar-640.png', render(640, fullBleed))
console.log('wrote docs/design/bot-avatar-640.png')
