/**
 * The listening bench (`npm run voice:bench`): says a few fixed lines in every tone, and as
 * written, in the voices of four men and four women, into node_modules/.cache/voice-bench/, with
 * an index.html to play and compare them by ear. Each run is a variant in a folder of its own and
 * the index shows every variant said so far side by side, so a change to TONES, PAUSE or the
 * ranges in speakerOf (src/server/voice.ts) is heard a few minutes later beside what was there
 * before.
 *
 *   --name <name>     the variant's folder (by default phrased, or whole)
 *   --whole           each line in one Kokoro call in its first tone, as before 2026-11-11
 *   --voices <n>      how many voices, half of them men (8)
 *   --lines <n>       how many of the fixed lines (3)
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { Kokoro, recipe, speakerOf, TONE_NAMES, type Phrase, type Speaker } from '../../src/server/voice.ts'

const { values: opts } = parseArgs({
  options: {
    name: { type: 'string' },
    whole: { type: 'boolean', default: false },
    voices: { type: 'string', default: '8' },
    lines: { type: 'string', default: '3' },
  },
})
const name = opts.name ?? (opts.whole ? 'whole' : 'phrased')

/** Lines of the kind Haiku writes now: two phrases, each in its tone. */
const ALL: Phrase[][] = [
  [
    { text: 'How dare you!', tone: 'indignant' },
    { text: 'My thesis is a masterpiece.', tone: 'booming' },
  ],
  [
    { text: 'Between ourselves,', tone: 'hushed' },
    { text: 'your bibliography was written by a goose.', tone: 'sniffy' },
  ],
  [
    { text: 'Thirty pages of errata!', tone: 'gloating' },
    { text: 'How very thorough of you.', tone: 'plain' },
  ],
]
const LINES = ALL.slice(0, Number(opts.lines))

const HERE = import.meta.dirname
const DIR = path.resolve(HERE, '../../node_modules/.cache/voice')
const OUT = path.resolve(HERE, '../../node_modules/.cache/voice-bench')
fs.mkdirSync(path.join(OUT, name), { recursive: true })

const voices: { key: string; speaker: Speaker }[] = []
for (let i = 0, n = Number(opts.voices); voices.length < n; i++) {
  const key = `bench-voice-${i}`
  const speaker = speakerOf(key, null)
  if (voices.filter((v) => v.speaker.sex === speaker.sex).length < n / 2) voices.push({ key, speaker })
}

interface Clip {
  voice: string
  line: number
  /** A tone every phrase is said in, or 'written': each phrase in its own. */
  as: string
  file: string
  secs: number
  ms: number
  phrases: { text: string; prosody: string; speed: number; db: number }[]
}

const kokoro = new Kokoro(DIR, (m) => console.log(m))
const clips: Clip[] = []
const t0 = performance.now()
for (const { key, speaker } of voices) {
  for (const [li, line] of LINES.entries()) {
    for (const as of ['written', ...TONE_NAMES] as const) {
      const toned = as === 'written' ? line : line.map((p) => ({ text: p.text, tone: as }))
      const said = opts.whole ? [{ text: toned.map((p) => p.text).join(' '), tone: toned[0]!.tone }] : toned
      const r = recipe(said, speaker, () => 0.5)
      const { mp3, secs, ms } = await kokoro.render(r)
      const file = `${key}-${li}-${as}.mp3`
      fs.writeFileSync(path.join(OUT, name, file), mp3)
      clips.push({ voice: key, line: li, as, file, secs, ms, phrases: r.phrases.map((p) => ({ text: p.text, prosody: p.prosody.map(([v, w]) => `${v} ${w.toFixed(2)}`).join(', '), speed: p.speed, db: p.db })) })
    }
  }
  console.log(`voice:bench ${name}: ${key} (${speaker.sex}) said, ${((performance.now() - t0) / 1000).toFixed(0)} s so far`)
}
kokoro.close()
fs.writeFileSync(path.join(OUT, name, 'clips.json'), JSON.stringify({ name, whole: opts.whole, at: new Date().toISOString(), voices, clips }, null, 1))

// The index: every variant said so far, one row per voice and line, a button per variant in each tone.
const variants = fs
  .readdirSync(OUT)
  .filter((d) => fs.existsSync(path.join(OUT, d, 'clips.json')))
  .map((d) => JSON.parse(fs.readFileSync(path.join(OUT, d, 'clips.json'), 'utf8')) as { name: string; whole: boolean; at: string; voices: typeof voices; clips: Clip[] })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const rows: string[] = []
for (const { key, speaker } of voices) {
  for (const [li, line] of LINES.entries()) {
    const cells = (['written', ...TONE_NAMES] as const).map((as) => {
      const buttons = variants.map((v) => {
        const c = v.clips.find((x) => x.voice === key && x.line === li && x.as === as)
        if (!c) return ''
        const recipeText = c.phrases.map((p) => `${p.text} | prosody ${p.prosody} | speed ${p.speed.toFixed(2)} | ${p.db} dB`).join('\n')
        return `<button data-src="${esc(`${v.name}/${c.file}`)}" title="${esc(`${recipeText}\n${c.secs.toFixed(2)} s, made in ${c.ms} ms`)}">${esc(v.name)}</button>`
      })
      return `<td>${buttons.join('')}</td>`
    })
    const who = li === 0 ? `<th rowspan="${LINES.length}">${esc(key)}<br>${speaker.sex}, temper ${speaker.temper}<br>${esc(speaker.own.map(([v, w]) => `${v} ${w.toFixed(2)}`).join(', '))}<br>pace ${speaker.pace.toFixed(2)}, deepen ${speaker.deepen.toFixed(3)}</th>` : ''
    rows.push(`<tr>${who}<td class="line">${esc(line.map((p) => `[${p.tone}] ${p.text}`).join(' '))}</td>${cells.join('')}</tr>`)
  }
}
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Voice bench</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; background: #faf8f4; color: #222; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ccc; padding: 4px 6px; vertical-align: top; text-align: left; }
th { font-weight: normal; background: #f0ece4; }
td.line { max-width: 22em; }
button { margin: 2px; cursor: pointer; }
button.on { background: #234; color: #fff; }
</style></head><body>
<h1>Voice bench</h1>
<p>Each row is one voice saying one line: as written (each phrase in its own tone), then every phrase in each tone. A button per variant; hover for the recipe. Variants: ${variants.map((v) => `${esc(v.name)} (${v.whole ? 'each line in one call, ' : ''}${v.at.slice(0, 16)})`).join('; ')}.</p>
<table><tr><th>Voice</th><th>Line</th>${['as written', ...TONE_NAMES].map((t) => `<th>${t}</th>`).join('')}</tr>
${rows.join('\n')}
</table>
<script>
const audio = new Audio()
let on = null
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-src]')
  if (!b) return
  if (on) on.classList.remove('on')
  on = b
  b.classList.add('on')
  audio.src = b.dataset.src
  void audio.play()
})
audio.onended = () => on && on.classList.remove('on')
</script>
</body></html>
`,
)
console.log(`voice:bench ${name}: ${clips.length} clips in ${((performance.now() - t0) / 1000).toFixed(0)} s; open ${path.join(OUT, 'index.html')}`)
