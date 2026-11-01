import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = await readFile(path.join(root, 'build', 'icon.svg'))
await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(path.join(root, 'build', 'icon.png'))
console.log('icon generated: build/icon.png')
