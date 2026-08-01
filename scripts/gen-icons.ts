// Rasterize public/favicon.svg into the PWA/install icons. Re-run if the SVG changes.
//   npx tsx scripts/gen-icons.ts
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/favicon.svg')

await sharp(svg, { density: 384 }).resize(192, 192).png().toFile('public/icon-192.png')
await sharp(svg, { density: 512 }).resize(512, 512).png().toFile('public/icon-512.png')
await sharp(svg, { density: 384 }).resize(180, 180).png().toFile('public/apple-touch-icon.png')

// Maskable: icon at ~80% on a solid themed background so platform masks don't clip it.
//
// The background is --accent-wash, NOT the ramp's darkest step. tl-19 specified
// #104281 and that value is wrong for this mark: the mark's own bottom bar is
// #104281, so a third of it would disappear into the plate and nobody would see it
// until the icon was already on a phone's home screen. The alternative was a
// re-stepped dark-surface variant of the mark, which means a third copy of the same
// geometry to keep in sync with favicon.svg and Mark.tsx. A pale blue plate keeps
// every bar legible, keeps the plate on-brand, and adds no asset.
const inner = await sharp(svg, { density: 512 }).resize(410, 410).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#eff6ff' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile('public/icon-maskable-512.png')

console.log('Wrote icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png')
