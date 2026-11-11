import { fileURLToPath } from 'node:url'

import { MPEGDecoder } from 'mpg123-decoder'
import { describe, expect, it } from 'vitest'

import { VOICES } from '../protocol'
import { delivered, phrased, recipe, sexOf, speakerOf, TONE_NAMES, voiceFromDisk, type Speaker, type Tone } from './voice'

const DIR = fileURLToPath(new URL('../../node_modules/.cache/voice', import.meta.url))
const KEYS = Array.from({ length: 24 }, (_, i) => `browser-key-${i}-a1b2c3`)
/** A key's own voice. */
const own = (key: string) => speakerOf(key, null)
/** One phrase said in a tone, as the worker is asked it. */
const said = (s: Speaker, tone: Tone) => recipe([{ text: 'Sirrah!', tone }], s, () => 0.5).phrases[0]!

describe('the voice', () => {
  it('gives every key an old English doctor of their own, man or woman, the same every time', () => {
    expect(KEYS.map(own)).toEqual(KEYS.map(own))
    expect(new Set(KEYS.map((k) => JSON.stringify(own(k).own))).size).toBe(KEYS.length)
    expect(new Set(KEYS.map((k) => own(k).sex))).toEqual(new Set(['man', 'woman']))
    expect(new Set(KEYS.map((k) => own(k).own[0][0])).size).toBeGreaterThan(5)
    for (const k of KEYS) {
      const s = own(k)
      expect(s.own[0][0]).toMatch(/^b[mf]_/)
      for (const [v] of s.own) {
        expect(VOICES).toContain(v)
        expect(sexOf(v)).toBe(s.sex)
      }
      // Slower and deeper than Kokoro speaks, and never read faster than it was made.
      expect(s.pace).toBeLessThan(1)
      expect(s.deepen).toBeLessThan(1)
    }
  })

  it('keeps every key’s voice as it was before the melody’s widening and the tremble were taken out (2026-11-11)', () => {
    expect(own('browser-key-0-a1b2c3')).toEqual({ sex: 'man', own: [['bm_daniel', 0.7036359227029607], ['bm_george', 0.29636407729703934]], pace: 0.908543045995757, deepen: 0.9202833472704515, temper: 'sniffy' })
    expect(own('browser-key-5-a1b2c3')).toEqual({ sex: 'man', own: [['bm_lewis', 0.6771139172022231], ['am_onyx', 0.3228860827977769]], pace: 0.9219616832816974, deepen: 0.9273052815068513, temper: 'sniffy' })
    expect(own('browser-key-test')).toEqual({ sex: 'woman', own: [['bf_lily', 0.6851383031578735], ['af_sarah', 0.31486169684212656]], pace: 0.8681661014119163, deepen: 0.9228143689711579, temper: 'gloating' })
    expect(own('key-Alice-123456')).toEqual({ sex: 'man', own: [['bm_daniel', 0.6405272266827524], ['am_eric', 0.35947277331724764]], pace: 0.9098324599582702, deepen: 0.8882287051598542, temper: 'gloating' })
    expect(own('0f3a9c27b1d4e8a6f5c2b913')).toEqual({ sex: 'woman', own: [['bf_isabella', 0.7705016029183753], ['af_aoede', 0.22949839708162473]], pace: 0.8773808775143698, deepen: 0.9144040420558304, temper: 'booming' })
  })

  it('leads with the voice a player chose and takes its sex, the rest still from the key', () => {
    for (const k of KEYS) {
      const o = own(k)
      // Their own lead, chosen by name, is their own voice.
      expect(speakerOf(k, o.own[0][0])).toEqual(o)
      for (const v of VOICES) {
        const s = speakerOf(k, v)
        expect(s.own[0][0]).toBe(v)
        expect(s.sex).toBe(sexOf(v))
        expect(s.own[1][0]).not.toBe(v)
        expect(sexOf(s.own[1][0])).toBe(s.sex)
        expect(s.own.map(([, w]) => w)).toEqual(o.own.map(([, w]) => w))
        expect(s.pace).toBe(o.pace)
        expect(s.temper).toBe(o.temper)
        // Aged by the key's own draw, a woman's voice deepened less than a man's.
        expect(s.deepen - (s.sex === 'man' ? 0.88 : 0.91)).toBeCloseTo(o.deepen - (o.sex === 'man' ? 0.88 : 0.91))
      }
    }
    // A key that drew a woman, with Onyx chosen: the tones pull toward men.
    const s = speakerOf(KEYS.find((k) => own(k).sex === 'woman')!, 'am_onyx')
    for (const [v] of said(s, 'booming').prosody) expect(sexOf(v)).toBe('man')
  })

  it('a tone moves only the prosody, toward voices of the doctor’s own sex (but Nicole’s hush)', () => {
    const man = own(KEYS.find((k) => own(k).sex === 'man')!)
    const woman = own(KEYS.find((k) => own(k).sex === 'woman')!)
    const weigh = (mix: [string, number][], ...names: string[]) => mix.filter(([v]) => names.includes(v)).reduce((a, [, w]) => a + w, 0)
    expect(said(man, 'plain').prosody).toEqual(man.own)
    // What a tone pulls toward: 0.6 of the prosody, besides what the doctor's own mix already had of those voices.
    const pulled = (s: Speaker, tone: Tone, ...names: string[]) => weigh(said(s, tone).prosody, ...names) - 0.4 * weigh(s.own, ...names)
    expect(pulled(man, 'booming', 'bm_lewis', 'am_onyx')).toBeCloseTo(0.6)
    expect(pulled(woman, 'booming', 'af_alloy', 'af_kore')).toBeCloseTo(0.6)
    expect(pulled(woman, 'hushed', 'af_nicole')).toBeCloseTo(0.6)
    expect(said(man, 'booming').speed).toBeLessThan(said(man, 'plain').speed)
    for (const s of [man, woman]) {
      for (const tone of TONE_NAMES) {
        const r = recipe([{ text: 'Sirrah!', tone }], s, () => 0.5)
        expect(r.timbre).toEqual(s.own)
        expect(r.deepen).toBe(s.deepen)
        const p = r.phrases[0]!
        expect(p.pause).toBe(0)
        for (const [v] of p.prosody) expect(v === 'af_nicole' || sexOf(v) === s.sex).toBe(true)
        expect(p.prosody.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1)
      }
    }
  })

  it('says a line phrase by phrase, each in its tone, with a pause between them, and the temper shows in the first two times in five', () => {
    const s = own(KEYS[0]!)
    const r = recipe(
      [
        { text: 'Sirrah!', tone: 'indignant' },
        { text: 'Your footnotes wobble.', tone: 'booming' },
      ],
      s,
      () => 0.5,
    )
    expect(r.phrases.map((p) => p.text)).toEqual(['Sirrah!', 'Your footnotes wobble.'])
    expect(r.phrases[1]!.speed).toBeLessThan(r.phrases[0]!.speed)
    expect(r.phrases[1]!.db).toBeGreaterThan(r.phrases[0]!.db)
    expect(r.phrases[1]!.pause).toBeCloseTo(0.2)
    const other = TONE_NAMES.find((t) => t !== s.temper && t !== 'plain')!
    const line = [
      { text: 'Sirrah!', tone: 'plain' },
      { text: 'Begone.', tone: other },
    ] satisfies { text: string; tone: Tone }[]
    expect(delivered(line, s, () => 0.1)).toEqual([{ text: 'Sirrah!', tone: s.temper }, line[1]])
    expect(delivered(line, s, () => 0.9)).toEqual(line)
    // Not when the phrase after it is already in the temper: the tone would not change.
    const tempered = [line[0], { text: 'Begone.', tone: s.temper }]
    expect(delivered(tempered, s, () => 0.1)).toEqual(tempered)
    expect(delivered([line[0]], s, () => 0.1)).toEqual([{ text: 'Sirrah!', tone: s.temper }])
  })

  it('cuts a line written without tones into at most three phrases, each answering the tone before', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const p = phrased('Sir or madam, your hypothesis wears borrowed trousers!', () => r)
      expect(p.map((x) => x.text)).toEqual(['Sir or madam,', 'your hypothesis wears borrowed trousers!'])
      expect(p[1]!.tone).not.toBe(p[0]!.tone)
    }
    expect(phrased('Even the library mice have dismissed your thesis.', Math.random).map((x) => x.text)).toEqual(['Even the library mice have dismissed your thesis.'])
    expect(phrased('One, two; three: four! Five?', Math.random).map((x) => x.text)).toEqual(['One,', 'two;', 'three: four! Five?'])
  })

  it('says a two-phrase line as MP3 in a worker while the game keeps its thread, its silence cut away and a pause between the phrases (needs what npm install fetched)', async () => {
    const voice = voiceFromDisk(DIR, () => {})
    expect(voice, `Kokoro is not in ${DIR}: run npm run voice`).not.toBeNull()
    let worst = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    const speech = await voice!.say(
      [
        { text: 'Your Latin is dreadful!', tone: 'indignant' },
        { text: 'An embarrassment to the guild.', tone: 'booming' },
      ],
      'browser-key-test',
      null,
    )
    clearInterval(tick)
    // The model holds its own thread for seconds; this one never waited long.
    expect(worst).toBeLessThan(250)
    expect(speech.tones).toHaveLength(2)
    expect(speech.tones[1]).toBe('booming')
    const bytes = Buffer.from(speech.mp3, 'base64')
    const decoder = new MPEGDecoder()
    await decoder.ready
    const pcm = decoder.decode(new Uint8Array(bytes))
    decoder.free()
    expect(pcm.sampleRate).toBe(24000)
    const secs = pcm.samplesDecoded / pcm.sampleRate
    expect(secs).toBeGreaterThan(1.5)
    expect(secs).toBeLessThan(6)
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
    // 10 ms frames within 35 dB of the loudest: little silence before the first or after the last
    // (Kokoro leaves about 0.24 s and 0.58 s), and a pause of at least 150 ms between the phrases
    // (neither has a comma inside, where Kokoro would pause on its own: joined without a pause, the
    // longest quiet was 0.10 to 0.11 s, and 0.2 to 0.3 s with it).
    const db: number[] = []
    for (let i = 0; i + 240 <= x.length; i += 240) db.push(10 * Math.log10(x.subarray(i, i + 240).reduce((a, v) => a + v * v, 0) / 240 + 1e-12))
    const loud = Math.max(...db)
    const sound = db.map((d) => d > loud - 35)
    const first = sound.indexOf(true)
    const end = sound.lastIndexOf(true)
    expect(first / 100).toBeLessThan(0.1)
    expect((db.length - 1 - end) / 100).toBeLessThan(0.3)
    let longest = 0
    for (let f = first, run = 0; f <= end; f++) longest = Math.max(longest, (run = sound[f] ? 0 : run + 1))
    expect(longest / 100).toBeGreaterThanOrEqual(0.15)
    // Closed, what is still waiting fails at once.
    const pending = voice!.say([{ text: 'Never to be heard.', tone: 'plain' }], 'browser-key-test', 'bm_george')
    voice!.close()
    await expect(pending).rejects.toThrow(/closed/)
  }, 60_000)
})
