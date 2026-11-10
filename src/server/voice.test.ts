import { fileURLToPath } from 'node:url'

import { MPEGDecoder } from 'mpg123-decoder'
import { describe, expect, it } from 'vitest'

import { MEN, recipe, speakerOf, voiceFromDisk, type Tone } from './voice'

const DIR = fileURLToPath(new URL('../../node_modules/.cache/voice', import.meta.url))

describe('the voice', () => {
  it('gives every key an old man of its own, the same every time', () => {
    const keys = Array.from({ length: 24 }, (_, i) => `browser-key-${i}-a1b2c3`)
    expect(keys.map(speakerOf)).toEqual(keys.map(speakerOf))
    const voices = new Set(keys.map((k) => JSON.stringify(speakerOf(k).own)))
    expect(voices.size).toBe(keys.length)
    expect(new Set(keys.map((k) => speakerOf(k).own[0]![0])).size).toBeGreaterThan(4)
    for (const k of keys) {
      const s = speakerOf(k)
      for (const [v] of s.own) expect(MEN).toContain(v)
      // Slower and deeper than Kokoro speaks, and never read faster than it was made.
      expect(s.pace).toBeLessThan(1)
      expect(s.age.deepen * (1 + s.age.depth)).toBeLessThan(1)
    }
  })

  it('a tone moves only the prosody toward the voices that speak that way, the timbre stays the doctor’s own', () => {
    const s = speakerOf('browser-key-tone')
    const weigh = (mix: [string, number][], name: string) => mix.filter(([v]) => v === name).reduce((a, [, w]) => a + w, 0)
    const plain = recipe('Sirrah!', s, 'plain')
    expect(plain.timbre).toEqual(s.own)
    expect(plain.prosody).toEqual(s.own)
    expect(weigh(recipe('Sirrah!', s, 'hushed').prosody, 'af_nicole')).toBeCloseTo(0.6)
    const booming = recipe('Sirrah!', s, 'booming')
    expect(weigh(booming.prosody, 'bm_lewis') + weigh(booming.prosody, 'am_onyx')).toBeCloseTo(0.6)
    expect(booming.speed).toBeLessThan(plain.speed)
    for (const tone of ['plain', 'booming', 'indignant', 'gloating', 'hushed', 'sniffy'] satisfies Tone[]) {
      const r = recipe('Sirrah!', s, tone)
      expect(r.timbre).toEqual(s.own)
      expect(r.age).toEqual(s.age)
      expect(r.prosody.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1)
    }
  })

  it('says a line as MP3 in a worker while the game keeps its thread (needs what npm install fetched)', async () => {
    const voice = voiceFromDisk(DIR, () => {})
    expect(voice, `Kokoro is not in ${DIR}: run npm run voice`).not.toBeNull()
    let worst = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    const speech = await voice!.say('Your Latin, sir, is an embarrassment to the entire guild!', 'browser-key-test')
    clearInterval(tick)
    // The model holds its own thread for seconds; this one never waited long.
    expect(worst).toBeLessThan(250)
    const bytes = Buffer.from(speech.mp3, 'base64')
    const decoder = new MPEGDecoder()
    await decoder.ready
    const pcm = decoder.decode(new Uint8Array(bytes))
    decoder.free()
    expect(pcm.sampleRate).toBe(24000)
    const secs = pcm.samplesDecoded / pcm.sampleRate
    expect(secs).toBeGreaterThan(1.5)
    expect(secs).toBeLessThan(10)
    expect(Math.abs(secs - speech.secs)).toBeLessThan(0.2)
    const x = pcm.channelData[0]!
    let sum = 0
    let peak = 0
    for (const v of x) {
      sum += v * v
      peak = Math.max(peak, Math.abs(v))
    }
    // Levelled: speech, not silence, its peaks under -1 dBFS (MP3 may overshoot a little).
    expect(Math.sqrt(sum / x.length)).toBeGreaterThan(0.03)
    expect(peak).toBeLessThan(1)
    // Closed, what is still waiting fails at once.
    const pending = voice!.say('Never to be heard.', 'browser-key-test')
    voice!.close()
    await expect(pending).rejects.toThrow(/closed/)
  }, 60_000)
})
