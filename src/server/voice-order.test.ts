import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Kokoro, recipe, speakerOf, type Phrase } from './voice'

const DIR = fileURLToPath(new URL('../../node_modules/.cache/voice', import.meta.url))

describe('the voice worker', () => {
  it('says lines one at a time in the order asked, a line of two phrases before a line of one asked after it (needs what npm install fetched)', async () => {
    const kokoro = new Kokoro(DIR, () => {})
    const s = speakerOf('browser-key-order', null)
    const back: string[] = []
    const ask = (name: string, phrases: Phrase[]) => kokoro.render(recipe(phrases, s, () => 0.5)).then(() => back.push(name))
    await Promise.all([
      ask('two', [
        { text: 'Pah!', tone: 'indignant' },
        { text: 'Begone.', tone: 'booming' },
      ]),
      ask('one', [{ text: 'Sirrah!', tone: 'plain' }]),
    ])
    kokoro.close()
    // Taking turns phrase by phrase, the line of one was said before the second phrase of the other.
    expect(back).toEqual(['two', 'one'])
  }, 60_000)
})
