/**
 * Fetches the voice the server speaks taunts in: Kokoro-82M as ONNX, its tokenizer and the 13 of its
 * voices the doctors are made of, from a pinned revision on Hugging Face into node_modules/.cache/voice (about 330 MB). It runs
 * after `npm install` and with `npm run voice`. sources.json names each file with its SHA-256; a file
 * already there is checked against it and kept. The stamp (.fetched, a hash of sources.json and this
 * script) skips the checking while nothing has changed. Anything that goes wrong stops with what it was doing.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = import.meta.dirname
const OUT = path.resolve(HERE, '../../node_modules/.cache/voice')
const sourcesText = fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8')
const { repo, revision, files } = JSON.parse(sourcesText) as { repo: string; revision: string; files: Record<string, string> }
const stamp = createHash('sha256').update(sourcesText).update(fs.readFileSync(import.meta.filename)).digest('hex')
const stampFile = path.join(OUT, '.fetched')

const log = (message: string) => console.log(`voice: ${message}`)

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  return h.digest('hex')
}

if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
  log('up to date')
} else {
  for (const [name, hash] of Object.entries(files)) {
    const file = path.join(OUT, name)
    if (fs.existsSync(file) && (await sha256(file)) === hash) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${name}`
    const res = await fetch(url, { headers: { 'User-Agent': 'dissertation-voice-fetch' } })
    if (!res.ok || !res.body) throw new Error(`downloading ${url}: HTTP ${res.status}`)
    const mb = Number(res.headers.get('content-length') ?? 0) / 1e6
    if (mb > 5) log(`downloading ${name} (${mb.toFixed(0)} MB)`)
    const part = `${file}.part`
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(part))
    const got = await sha256(part)
    if (got !== hash) throw new Error(`${name} came with SHA-256 ${got}, not ${hash}`)
    fs.renameSync(part, file)
  }
  fs.writeFileSync(stampFile, stamp)
  log(`Kokoro-82M and ${Object.keys(files).filter((f) => f.startsWith('voices/')).length} voices in ${path.relative(process.cwd(), OUT)}`)
}
