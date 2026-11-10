/**
 * Builds sounds/ from CC0 packs on OpenGameArt. It runs after `npm install` and with `npm run sounds`.
 *
 * sources.json names the downloads and, for each sound the game plays, the recordings in them it is
 * made of, in order: recording n becomes sounds/<name>/<n>.mp3. Each is decoded, trimmed of its
 * silence and cut to the sound's length, levelled on its loudest 200 ms with its peaks under -1 dBFS,
 * faded at both ends and written as mono MP3 at 96 kbps; sounds/library.json lists the variants and
 * each sound's gain in the mix. Downloads are kept in node_modules/.cache/sounds (about 284 MB), so a
 * rebuild does not fetch them again. sounds/.built holds a hash of sources.json and this script: while it matches,
 * there is nothing to do. Anything that goes wrong stops the build with what it was doing.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Mp3Encoder } from '@breezystack/lamejs'
import { FLACDecoder } from '@wasm-audio-decoders/flac'
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis'
import sevenZip from '7zip-bin'
import { MPEGDecoder } from 'mpg123-decoder'

interface Pack {
  name: string
  /** Where the pack is described and credited. */
  page: string
  /** What is downloaded: an archive (.zip, .7z) or a single recording. */
  file: string
}

interface Sound {
  /** Seconds kept at most (faded out). */
  secs: number
  /** Loudness of the loudest 200 ms, dBFS. */
  level: number
  /** Gain at play time, for the mix. */
  gain: number
  /** Recordings, as `<pack>/<file>` for a single one or `<pack>/x/<path in the archive>`. */
  from: string[]
}

interface Pcm {
  rate: number
  data: Float32Array
}

const HERE = import.meta.dirname
const ROOT = path.resolve(HERE, '../..')
const OUT = path.join(ROOT, 'sounds')
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'sounds')
const SOURCES = path.join(HERE, 'sources.json')

const sourcesText = fs.readFileSync(SOURCES, 'utf8')
const { packs, sounds } = JSON.parse(sourcesText) as { packs: Record<string, Pack>; sounds: Record<string, Sound> }
const stamp = createHash('sha256').update(sourcesText).update(fs.readFileSync(import.meta.filename)).digest('hex')
const stampFile = path.join(OUT, '.built')

const log = (message: string) => console.log(`sounds: ${message}`)

// ------------------------------------------------------------------------------ the packs

const fileName = (pack: Pack) => decodeURIComponent(pack.file.split('/').at(-1)!)
const isArchive = (pack: Pack) => /\.(zip|7z)$/i.test(fileName(pack))

/** Downloads a pack into the cache unless it is there, and unpacks an archive into x/ beside it. */
async function fetchPack(id: string, pack: Pack): Promise<void> {
  const dir = path.join(CACHE, id)
  const file = path.join(dir, fileName(pack))
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(file)) {
    const res = await fetch(pack.file, { headers: { 'User-Agent': 'dissertation-sound-build' } })
    if (!res.ok || !res.body) throw new Error(`downloading ${pack.file}: HTTP ${res.status}`)
    const mb = Number(res.headers.get('content-length') ?? 0) / 1e6
    log(`downloading ${pack.name}: ${fileName(pack)}${mb ? ` (${mb.toFixed(1)} MB)` : ''}`)
    const part = `${file}.part`
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(part))
    fs.renameSync(part, file)
  }
  const unpacked = path.join(dir, 'x')
  if (!isArchive(pack) || fs.existsSync(unpacked)) return
  // The package ships 7za without its execute bit.
  fs.chmodSync(sevenZip.path7za, 0o755)
  const part = `${unpacked}.part`
  fs.rmSync(part, { recursive: true, force: true })
  const r = spawnSync(sevenZip.path7za, ['x', '-y', `-o${part}`, file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`unpacking ${file}: ${(r.stderr || r.stdout || String(r.error)).trim().slice(-500)}`)
  fs.renameSync(part, unpacked)
}

// ------------------------------------------------------------------------------ decoding

function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!
  const n = Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(n)
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length
  return out
}

/** WAV: PCM of 8, 16, 24 or 32 bits, or float. */
function wav(buf: Buffer): Pcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav')
  let pos = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body)
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24)
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * fmt.channels))
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (f * fmt.channels + c) * bytes
          let v: number
          if (fmt.format === 3) v = bytes === 4 ? buf.readFloatLE(o) : buf.readDoubleLE(o)
          else if (bytes === 1) v = (buf.readUInt8(o) - 128) / 128
          else if (bytes === 2) v = buf.readInt16LE(o) / 32768
          else if (bytes === 3) v = buf.readIntLE(o, 3) / 8388608
          else v = buf.readInt32LE(o) / 2147483648
          chans[c]![f] = v
        }
      }
      return { rate: fmt.rate, data: mono(chans) }
    }
    pos = body + size + (size % 2)
  }
  throw new Error('no data in wav')
}

/** Any recording in the packs as mono float PCM: WAV, Ogg Vorbis, MP3 or FLAC. */
async function decode(file: string): Promise<Pcm> {
  const buf = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase()
  if (ext === '.wav') return wav(buf)
  const bytes = new Uint8Array(buf)
  let decoded: { channelData: Float32Array[]; sampleRate: number }
  if (ext === '.mp3') {
    const dec = new MPEGDecoder()
    await dec.ready
    decoded = dec.decode(bytes)
    dec.free()
  } else if (ext === '.ogg') {
    const dec = new OggVorbisDecoder()
    await dec.ready
    decoded = await dec.decodeFile(bytes)
    dec.free()
  } else if (ext === '.flac') {
    const dec = new FLACDecoder()
    await dec.ready
    decoded = await dec.decodeFile(bytes)
    dec.free()
  } else throw new Error(`no decoder for ${ext}`)
  return { rate: decoded.sampleRate, data: mono(decoded.channelData) }
}

// ------------------------------------------------------------------------------ shaping

/** To 44.1 kHz, unless the rate is one MP3 takes as it is. */
function resample(p: Pcm): Pcm {
  if (p.rate === 44100 || p.rate === 48000 || p.rate === 32000) return p
  const to = 44100
  const k = p.rate / to
  const n = Math.floor(p.data.length / k)
  const out = new Float32Array(n)
  const w = Math.max(1, Math.round(k))
  for (let i = 0; i < n; i++) {
    const c = i * k
    let s = 0
    for (let j = 0; j < w; j++) s += p.data[Math.min(p.data.length - 1, Math.floor(c) + j)]!
    out[i] = s / w
  }
  return { rate: to, data: out }
}

/** Trimmed, cut to length, levelled and faded; null for a recording that is all silence. */
function shape(p: Pcm, s: Sound): Float32Array | null {
  const d = p.data
  const thr = 10 ** (-48 / 20)
  let a = 0
  while (a < d.length && Math.abs(d[a]!) < thr) a++
  let b = d.length - 1
  while (b > a && Math.abs(d[b]!) < thr) b--
  if (b - a < p.rate * 0.02) return null
  const start = Math.max(0, a - Math.floor(p.rate * 0.004))
  const keep = Math.min(b + 1 - start, Math.floor(s.secs * p.rate))
  const out = d.slice(start, start + keep)
  // Level the loudest 200 ms to the target; keep peaks under -1 dBFS.
  const win = Math.floor(p.rate * 0.2)
  let best = 0
  let sum = 0
  for (let i = 0; i < out.length; i++) {
    sum += out[i]! * out[i]!
    if (i >= win) sum -= out[i - win]! * out[i - win]!
    best = Math.max(best, sum / Math.min(win, i + 1))
  }
  const rms = Math.sqrt(best) || 1e-6
  let g = 10 ** (s.level / 20) / rms
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  g = Math.min(g, 10 ** (-1 / 20) / (peak || 1e-6))
  const fadeIn = Math.floor(p.rate * 0.002)
  const fadeOut = Math.min(out.length, Math.floor(p.rate * 0.06))
  for (let i = 0; i < out.length; i++) {
    let f = 1
    if (i < fadeIn) f = i / fadeIn
    if (i > out.length - fadeOut) f = Math.min(f, (out.length - i) / fadeOut)
    out[i] = out[i]! * g * f
  }
  return out
}

function mp3(data: Float32Array, rate: number): Buffer {
  const enc = new Mp3Encoder(1, rate, 96)
  const pcm = new Int16Array(data.length)
  for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(data[i]! * 32767)))
  const parts: Uint8Array[] = []
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152))
    if (b.length) parts.push(new Uint8Array(b))
  }
  const end = enc.flush()
  if (end.length) parts.push(new Uint8Array(end))
  return Buffer.concat(parts)
}

// ------------------------------------------------------------------------------ building

if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
  log('up to date')
} else {
  for (const [id, pack] of Object.entries(packs)) await fetchPack(id, pack)
  // Built beside the old folder and swapped in whole, so a failed build leaves nothing half done.
  const part = `${OUT}.part`
  fs.rmSync(part, { recursive: true, force: true })
  const library: Record<string, { files: string[]; gain: number }> = {}
  let bytes = 0
  for (const [name, sound] of Object.entries(sounds)) {
    fs.mkdirSync(path.join(part, name), { recursive: true })
    const files: string[] = []
    for (const src of sound.from) {
      const file = path.join(CACHE, src)
      const pcm = resample(await decode(file).catch((err: Error) => Promise.reject(new Error(`${name}: ${src}: ${err.message}`))))
      const shaped = shape(pcm, sound)
      if (!shaped) throw new Error(`${name}: ${src} is silent`)
      const out = mp3(shaped, pcm.rate)
      const variant = `${files.length}.mp3`
      fs.writeFileSync(path.join(part, name, variant), out)
      bytes += out.length
      files.push(variant)
    }
    library[name] = { files, gain: sound.gain }
  }
  fs.writeFileSync(path.join(part, 'library.json'), JSON.stringify(library, null, 1))
  fs.writeFileSync(path.join(part, '.built'), stamp)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.renameSync(part, OUT)
  // The downloads stay for the next build; what was unpacked from them goes (unpacking again takes seconds).
  for (const id of Object.keys(packs)) fs.rmSync(path.join(CACHE, id, 'x'), { recursive: true, force: true })
  log(`${Object.keys(library).length} sounds, ${Object.values(library).reduce((n, e) => n + e.files.length, 0)} recordings, ${(bytes / 1e6).toFixed(1)} MB in sounds/`)
}
