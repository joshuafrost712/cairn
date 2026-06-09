// Rasterize public/favicon.svg into the PWA/install icons. Re-run if the SVG changes.
//   npx tsx scripts/gen-icons.ts
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/favicon.svg')

await sharp(svg, { density: 384 }).resize(192, 192).png().toFile('public/icon-192.png')
await sharp(svg, { density: 512 }).resize(512, 512).png().toFile('public/icon-512.png')
await sharp(svg, { density: 384 }).resize(180, 180).png().toFile('public/apple-touch-icon.png')

// Maskable: icon at ~80% on a solid themed background so platform masks don't clip it.
const inner = await sharp(svg, { density: 512 }).resize(410, 410).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#1f2937' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile('public/icon-maskable-512.png')

console.log('Wrote icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png')
