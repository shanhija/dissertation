/**
 * A voice chosen by name in the dressing room (2026-11-11: "allow the player to choose their voice
 * character name"): carried in the profile, checked against the voices offered, passed to the
 * voice, and heard on the next V.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { randomLook } from '../doctor'
import type { VoiceName } from '../protocol'
import { initPhysics } from '../sim/sim'
import { FakeConn, FakeVoice, flush, heardAs, setup } from './fakes'
import { speakerOf } from './voice'

beforeAll(async () => {
  await initPhysics()
})

/** A page saying hello with its own profile, whatever its voice says. */
function page(game: ReturnType<typeof setup>['game'], name: string, voice: unknown) {
  const conn = new FakeConn()
  const h = game.connect(conn)
  const key = `key-${name}-123456`
  h.message(JSON.stringify({ type: 'hello', key, profile: { name, title: 'On Ducks', look: randomLook(Math.random, {}), voice } }))
  const profile = (voice: unknown) => h.message(JSON.stringify({ type: 'profile', profile: { ...conn.last('profile')!.profile, voice } }))
  return { conn, key, profile, taunt: () => h.message(JSON.stringify({ type: 'taunt' })) }
}

describe('a voice chosen by name', () => {
  it('is taken only from the voices offered, anything else is the player’s own, and the page is told which voice is its own', async () => {
    const voice = new FakeVoice()
    const { game } = setup(null, voice)
    const adam = page(game, 'Adam', 'am_adam')
    await flush()
    expect(adam.conn.last('welcome')!.ownVoice).toBe(speakerOf(adam.key, null).own[0][0])
    expect(adam.conn.last('profile')!.profile.voice).toBeNull()
    expect(voice.said.map((s) => s.voice)).toEqual([null])
    for (const unknown of ['nobody', 'af_nicole', 42, undefined, { voice: 'bf_emma' }]) {
      adam.profile('bf_emma')
      await flush()
      expect(voice.said.at(-1)!.voice).toBe('bf_emma')
      adam.profile(unknown)
      await flush()
      expect(voice.said.at(-1)!.voice).toBeNull()
    }
    game.close()
  })

  it('is passed to the voice from the first line, and heard on V', async () => {
    const voice = new FakeVoice()
    const { game } = setup(null, voice)
    const lewis = page(game, 'Lewis', 'bm_lewis')
    await flush()
    expect(lewis.conn.last('profile')!.profile.voice).toBe('bm_lewis')
    expect(voice.said).toEqual([{ text: expect.any(String), key: lewis.key, voice: 'bm_lewis' }])
    lewis.taunt()
    await flush()
    const t = lewis.conn.last('taunt')!
    expect(heardAs(t.voice)).toBe(`${lewis.key} as bm_lewis: ${t.text}`)
    game.close()
  })

  it('says the next taunt in the new voice: the line said ahead in the old one is said again, once, after it is done', async () => {
    const voice = new FakeVoice()
    const { game, join } = setup(null, voice)
    voice.hold = true
    const a = join('Alice')
    await flush()
    expect(voice.said.map((s) => s.voice)).toEqual([null])
    const change = (v: VoiceName | null) => a.send({ type: 'profile', profile: { ...a.conn.last('profile')!.profile, voice: v } })
    // Changed twice while her own is still being said: only the last is said, after it.
    change('bm_george')
    change('af_bella')
    await flush()
    expect(voice.said).toHaveLength(1)
    voice.hold = false
    voice.release()
    await flush()
    expect(voice.said.map((s) => s.voice)).toEqual([null, 'af_bella'])
    expect(voice.said[1]!.text).toBe(voice.said[0]!.text)
    a.send({ type: 'taunt' })
    await flush()
    const t = a.conn.last('taunt')!
    expect(t.text).toBe(voice.said[0]!.text)
    expect(heardAs(t.voice)).toBe(`key-Alice-123456 as af_bella: ${t.text}`)
    // The one after is said in her new voice from the start.
    expect(voice.said.at(-1)!.voice).toBe('af_bella')
    expect(voice.said.at(-1)!.text).not.toBe(t.text)
    // Back to her own: said again, and heard so.
    change(null)
    await flush()
    expect(voice.said.at(-1)!.voice).toBeNull()
    expect(voice.said.at(-1)!.text).toBe(voice.said.at(-2)!.text)
    game.close()
  })
})
