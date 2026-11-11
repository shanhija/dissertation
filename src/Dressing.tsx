/**
 * The dressing room: the first thing a player sees, and every break while Opus builds the next
 * arena. Set like an open book over the robing room (2026-11-10: "make it coherent and
 * consistent", then "the doc in dressing room should have far more realestate"): the room fills
 * the screen, and the doctor turns on a stand as large as the gap between the pages allows (drag
 * to turn it), over a brass plaque with their name. The left page is the committee (who is here
 * and ready, the next arena, what was said, the chair's settings, where friends join); the right
 * page the dossier (the name, needed; the thesis, which the committee writes when it is left
 * empty; the voice, their own or one of Kokoro's by name; what they bring to their defence, made
 * once they are Ready; a line to say how the doctor looks, which Opus makes; height, build, walk
 * and colours; the wardrobe of every part anyone has had made). Along the foot: when the round
 * starts, the wins the match needs, Taunt and Ready.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BoxGeometry, Color, CylinderGeometry, Euler, Matrix4, Mesh, PMREMGenerator, Quaternion, Vector3, type BufferGeometry, type PerspectiveCamera } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import type { Net } from './net'
import { BUDGET_WINDOW, CRATE_OWNER_ONLY, FISTS_BUDGET, GAITS, MATCH_WINS, SLOTS, VOICES, type Gait, type Lobby, type Look, type PlayerInfo, type Profile, type Slot, type VoiceName } from './protocol'
import { DoctorMesh } from './scene/doctor'
import { prepared, surface } from './scene/materials'
import { setEngraving } from './scene/paint'
import { lighting } from './lighting'
import { openOptions } from './options'
import { play, speak, wakeAudio } from './sounds'

/** How each way of walking is called in the dressing room. */
const GAIT_NAMES: Record<Gait, string> = {
  chance: 'By chance',
  steady: 'Steady',
  limp: 'With a limp',
  hunched: 'Hunched',
  shuffle: 'Shuffling',
  waddle: 'Waddling',
  pompous: 'Pompous',
  doddery: 'Doddery',
}

const SLOT_NAMES: Record<Slot, string> = {
  hair: 'Hair',
  head: 'On the head',
  face: 'On the face',
  body: 'On the body',
  back: 'On the back',
  feet: 'On the feet',
}
/** A voice as the dossier names it, from Kokoro's name for it (bm_george): George, a British man. */
const voiceName = (v: VoiceName) => `${v[3]!.toUpperCase()}${v.slice(4)}, ${v[0] === 'b' ? 'a British' : 'an American'} ${v[1] === 'm' ? 'man' : 'woman'}`
/** The voices in the order the dossier offers them: British before American, men before women, then by name. */
const voiceOrder = (v: VoiceName) => `${v[0] === 'b' ? 0 : 1}${v[1] === 'm' ? 0 : 1}${v.slice(3)}`
const VOICE_LIST = [...VOICES].sort((a, b) => voiceOrder(a).localeCompare(voiceOrder(b)))

/** What becomes of what one brings to one's defence, as the dossier says it. */
const BRINGING: Record<PlayerInfo['bringing'], string> = {
  none: 'Made once you are Ready, it waits in a crate beside you as the round begins.',
  queued: 'Waiting its turn to be made. You may still change the words.',
  making: 'Being made.',
  ready: 'Made. It waits in a crate beside you as the round begins.',
  failed: 'Its design failed: a thing from the archive waits in a crate beside you instead.',
}

/** Seconds as minutes and seconds, 1:05. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** How a build reads, thin to round. */
const buildName = (b: number) => (b < 0.9 ? 'Thin' : b < 1.0 ? 'Slight' : b < 1.12 ? 'Average' : b < 1.22 ? 'Stout' : 'Round')

const COLOURS: [keyof Look, string][] = [
  ['skin', 'Skin'],
  ['eyes', 'Eyes'],
  ['coat', 'Lab coat'],
  ['shirt', 'Shirt'],
  ['trousers', 'Trousers'],
  ['shoes', 'Shoes'],
]

/** The robing room round the stand: a plank floor, a rug, panelling, shelves of books, a lamp, and a room of light to reflect. */
function Room() {
  const { gl, scene } = useThree()
  const pieces = useMemo(() => {
    const out: Mesh[] = []
    const piece = (g: BufferGeometry, name: Parameters<typeof surface>[0], color: string, at: [number, number, number], rot: [number, number, number] = [0, 0, 0]) => {
      const m4 = new Matrix4().compose(new Vector3(...at), new Quaternion().setFromEuler(new Euler(...rot)), new Vector3(1, 1, 1))
      const mesh = new Mesh(prepared(g, m4, name, color), surface(name))
      g.dispose()
      mesh.receiveShadow = true
      mesh.castShadow = true
      out.push(mesh)
    }
    piece(new BoxGeometry(18, 0.2, 18), 'planks', '#9a6a3e', [0, -0.1, 3.4])
    piece(new CylinderGeometry(1.5, 1.5, 0.02, 48), 'carpet', '#7c2430', [0, 0.01, 0])
    piece(new CylinderGeometry(0.75, 0.85, 0.22, 40), 'marble', '#ece6da', [0, 0.11, 0])
    for (const x of [-4.4, 0, 4.4]) piece(new BoxGeometry(3.6, 3.2, 0.5), 'books', '#ffffff', [x, 1.6, -2.6])
    piece(new BoxGeometry(18, 0.9, 0.3), 'wood', '#4e3220', [0, 3.6, -2.55])
    piece(new BoxGeometry(18, 1.6, 0.3), 'stone', '#b9ae98', [0, 4.8, -2.65])
    for (const x of [-6.6, -2.2, 2.2, 6.6]) piece(new BoxGeometry(0.8, 4.6, 0.6), 'wood', '#5a3a24', [x, 2.3, -2.5])
    return out
  }, [])
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.5
    pmrem.dispose()
    return () => {
      scene.environment?.dispose()
      scene.environment = null
    }
  }, [gl, scene])
  return (
    <>
      {pieces.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
      <pointLight position={[1.4, 2.7, 1.4]} intensity={9} distance={9} color="#ffd9a0" />
    </>
  )
}

/** Where on the page the doctor is shown: the whole room behind, the doctor in the gap between the pages, above the plaque. */
interface Framing {
  backdrop: React.RefObject<HTMLDivElement | null>
  gap: React.RefObject<HTMLDivElement | null>
  plaque: React.RefObject<HTMLDivElement | null>
}

/** How much of the room, top to bottom, the doctor's space shows: the tallest doctor on the stand, and a little air. */
const FRAMED = 2.3

function Stand({ net, turn, framing }: { net: Net; turn: React.MutableRefObject<number>; framing: Framing }) {
  const doctor = useMemo(() => new DoctorMesh(), [])
  const { camera, size, gl } = useThree()
  useEffect(() => () => doctor.dispose(), [doctor])
  useFrame((_, dt) => {
    // The engraving as the lighting tab has it, judged as under an open sky (not by the last arena's roof).
    setEngraving(1, lighting().hatchSpacing * gl.getPixelRatio())
    // The doctor as large as the gap between the pages allows, and in its middle: the camera
    // stands back until FRAMED metres fill the gap's height, and the picture is shifted so the
    // middle of the view falls on the middle of the gap.
    const b = framing.backdrop.current?.getBoundingClientRect()
    const g = framing.gap.current?.getBoundingClientRect()
    const below = framing.plaque.current?.getBoundingClientRect().height ?? 0
    if (b && g && g.height > 120) {
      const cam = camera as PerspectiveCamera
      const space = g.height - below - 16
      const seen = (FRAMED * size.height) / Math.max(100, space)
      const back = seen / (2 * Math.tan((cam.fov * Math.PI) / 360))
      cam.position.set(0, 1.3, back)
      cam.lookAt(0, 1.15, 0)
      const cx = g.left - b.left + g.width / 2
      const cy = g.top - b.top + space / 2
      cam.setViewOffset(size.width, size.height, size.width / 2 - cx, size.height / 2 - cy, size.width, size.height)
    }
    turn.current += dt * 0.35
    doctor.dress(net.profile.look, net.wardrobe, net.you ?? '')
    doctor.tag.sprite.visible = false
    // Walking on the spot as it turns, so its gait shows.
    const yaw = turn.current
    doctor.pose(
      {
        yaw,
        pitch: Math.sin(performance.now() / 1400) * 0.15,
        vel: [Math.sin(yaw) * 1.4, 0, Math.cos(yaw) * 1.4],
        grounded: true,
        hands: [null, null],
        riding: false,
        writing: false,
        held: false,
        hurt: 9,
        size: 1,
        shake: 0,
        glow: null,
        cred: 100,
      },
      performance.now() / 1000,
    )
  })
  return (
    <>
      <group position={[0, 0.22, 0]}>
        <primitive object={doctor.root} />
      </group>
      <Room />
      <hemisphereLight args={['#fff4dc', '#3a2a20', 0.7]} />
      <directionalLight position={[2, 4, 3]} intensity={1.8} castShadow shadow-mapSize={[2048, 2048]} />
    </>
  )
}

export function Dressing({ net, lobby }: { net: Net; lobby: Lobby }) {
  const [profile, setProfileState] = useState<Profile>(net.profile)
  const [ask, setAsk] = useState('')
  const [bring, setBring] = useState('')
  const bringTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [slot, setSlot] = useState<Slot>('hair')
  const [taunts, setTaunts] = useState<{ id: number; who: string; text: string }[]>([])
  const turn = useRef(0)
  const drag = useRef<number | null>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const gap = useRef<HTMLDivElement>(null)
  const plaque = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const me = lobby.players.find((p) => p.id === net.you)
  const chair = me?.chair ?? false

  // The server may change the profile (a title written, a look made): take it in.
  useEffect(() => net.subscribe(() => setProfileState(net.profile)), [net])
  useEffect(
    () =>
      net.onTaunt((t) => {
        speak(t.voice, null, null, () => null)
        setTaunts((list) => [
          ...list.slice(-4),
          {
            id: t.when,
            who: net.player(t.by)?.name ?? 'Someone',
            text: t.text,
          },
        ])
      }),
    [net],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'KeyV') net.send({ type: 'taunt' })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [net])

  const update = (p: Profile, now = false) => {
    setProfileState(p)
    net.profile = p
    if (timer.current) clearTimeout(timer.current)
    if (now) net.setProfile(p)
    else timer.current = setTimeout(() => net.setProfile(p), 400)
  }
  const setLook = (l: Partial<Look>) => update({ ...profile, look: { ...profile.look, ...l } }, true)
  const wear = (s: Slot, id: string | null) => {
    const worn = { ...profile.look.worn }
    if (id) worn[s] = id
    else delete worn[s]
    setLook({ worn })
    play('ui', 1.1)
  }
  // What they bring, as the field shows it, whenever the page (re)connects: a reloaded page's empty
  // field is what the server keeps, not the words typed before; a page back from a network blink
  // keeps its words on both sides.
  useEffect(() => {
    if (net.connected) net.send({ type: 'bring', text: bring })
    // Only on (re)connecting: the words as they are typed go through writeBring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.connected])
  /** What they bring goes to the server as it is written, a moment after the last key (the last words win). */
  const writeBring = (t: string) => {
    setBring(t)
    if (bringTimer.current) clearTimeout(bringTimer.current)
    bringTimer.current = setTimeout(() => net.send({ type: 'bring', text: t }), 400)
  }
  const sendAsk = () => {
    const t = ask.trim()
    if (!t) return
    net.send({ type: 'dress', text: t })
    setAsk('')
    play('ui', 1.3)
  }

  const parts = [...net.wardrobe.values()].filter((p) => p.slot === slot)
  const humans = lobby.players.filter((p) => !p.bot)
  const note = net.note && net.note.until > performance.now() ? net.note.text : null
  const arena = lobby.arena
  const bringing = me?.bringing ?? 'none'

  const ornament = (
    <div className="ornament">
      <i />
    </div>
  )

  return (
    <div className="dressing" onPointerDown={() => wakeAudio()}>
      <div
        className="backdrop"
        ref={backdrop}
        onPointerDown={(e) => (drag.current = e.clientX)}
        onPointerMove={(e) => {
          if (drag.current === null) return
          turn.current += (e.clientX - drag.current) * 0.01
          drag.current = e.clientX
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <Canvas
          shadows="percentage"
          dpr={[1, 1.5]}
          camera={{ position: [0, 1.3, 6], fov: 30 }}
          onCreated={({ scene }) => {
            scene.background = new Color('#1a1310')
          }}
        >
          <Stand net={net} turn={turn} framing={{ backdrop, gap, plaque }} />
        </Canvas>
      </div>
      <header>
        <h1>Dissertation</h1>
        <div className="tagline">Defend your thesis. Literally.</div>
        <button className="options-button small" onClick={() => openOptions()}>
          Options <kbd>O</kbd>
        </button>
      </header>

      <section className="page committee">
        <div className="page-body">
          <h2>The Committee</h2>
          {ornament}
          <div className="players">
            {lobby.players.map((p) => (
              <div key={p.id} className="player">
                <span className="dot" style={{ background: p.color }} />
                <span>
                  <span className="pname">{p.name || 'No name yet'}</span>
                  {p.wins > 0 && (
                    <span className="wins" title={`${p.wins} round${p.wins === 1 ? '' : 's'} won`}>
                      {'★'.repeat(p.wins)}
                    </span>
                  )}
                </span>
                {p.title && <div className="ptitle">{p.title}</div>}
                <div className="tags">
                  {p.chair && <span className="tag">Chair</span>}
                  {p.bot && <span className="tag">Bot</span>}
                  {p.dressing && <span className="tag">At the tailor</span>}
                  <span className={p.ready ? 'state ready' : 'state'}>{p.ready ? 'Ready ✓' : p.dressing ? 'Dressing…' : 'Not ready'}</span>
                </div>
              </div>
            ))}
          </div>

          <h3>The next arena</h3>
          <div className="arena-status">
            {arena.state === 'ready' ? (
              <b>{arena.name}</b>
            ) : arena.state === 'building' ? (
              <>
                <div className={`arena-build ${arena.since >= arena.expect ? 'late' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={arena.expect} aria-valuenow={Math.min(arena.since, arena.expect)}>
                  <i style={{ width: `${Math.min(100, (arena.since / arena.expect) * 100)}%` }} />
                </div>
                The committee is building a new one: {clock(arena.since)} so far, {arena.since < arena.expect ? <>nearly always done by {clock(arena.expect)}</> : 'longer than usual'}. If everyone is ready first, a kept one is played.
              </>
            ) : (
              'A kept arena is played next.'
            )}
          </div>

          {taunts.length > 0 && (
            <>
              <h3>Heard in the hall</h3>
              {taunts.map((t) => (
                <div key={t.id} className="taunt-line">
                  <b>{t.who}:</b> “{t.text}”
                </div>
              ))}
            </>
          )}

          {chair && (
            <>
              <h3>The chair decides</h3>
              <div className="chair-row">
                <span>Bots</span>
                <span className="stepper">
                  <button
                    className="small"
                    disabled={lobby.settings.bots <= 0}
                    onClick={() =>
                      net.send({
                        type: 'settings',
                        settings: {
                          ...lobby.settings,
                          bots: lobby.settings.bots - 1,
                        },
                      })
                    }
                    aria-label="One bot fewer"
                  >
                    −
                  </button>
                  <output>{lobby.settings.bots}</output>
                  <button
                    className="small"
                    disabled={lobby.settings.bots >= 7}
                    onClick={() =>
                      net.send({
                        type: 'settings',
                        settings: {
                          ...lobby.settings,
                          bots: lobby.settings.bots + 1,
                        },
                      })
                    }
                    aria-label="One bot more"
                  >
                    +
                  </button>
                </span>
              </div>
              <div className="chair-row">
                <span>Arenas</span>
                <select
                  value={lobby.settings.arena}
                  onChange={(e) =>
                    net.send({
                      type: 'settings',
                      settings: {
                        ...lobby.settings,
                        arena: e.target.value === 'anything' ? 'anything' : 'academic',
                      },
                    })
                  }
                >
                  <option value="academic">Academic places</option>
                  <option value="anything">Anything at all</option>
                </select>
              </div>
              <div className="chair-row">
                <span>Rounds to win</span>
                <select
                  value={lobby.settings.wins ?? 'room'}
                  onChange={(e) =>
                    net.send({
                      type: 'settings',
                      settings: {
                        ...lobby.settings,
                        wins: MATCH_WINS.find((w) => String(w) === e.target.value) ?? null,
                      },
                    })
                  }
                >
                  <option value="room">{lobby.settings.wins === null ? `By the room: ${lobby.wins}` : 'By the room'}</option>
                  {MATCH_WINS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <h3>How a defence goes</h3>
          <div className="rules">
            <p>What you bring waits in a crate beside you as the round begins.</p>
            <p>
              <kbd>T</kbd> asks for anything, <kbd>R</kbd> for something nobody has had: a crate comes with your name on it, yours alone for {CRATE_OWNER_ONLY} s once ready, then anyone's.
            </p>
            <p>
              <kbd>E</kbd> opens it, and each mouse button works its own hand. An empty hand shoves, at most {FISTS_BUDGET} from each in {BUDGET_WINDOW} s.
            </p>
            <p>Dismissed, you may review a player you watch (not a bot), once a round: it bends their next request. The last doctor standing wins the round.</p>
          </div>

          {lobby.join.length > 0 && humans.length < 8 && (
            <>
              <h3>Friends join at</h3>
              {lobby.join.map((j) => (
                <div key={j} className="join-at">
                  {j}
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <div className="stand-gap" ref={gap}>
        <div className="stand-hint">Drag to turn</div>
        {me?.dressing && <div className="making plate">The tailor is at work…</div>}
        <div className="plaque" ref={plaque}>
          <div className="plaque-name">{profile.name.trim() || 'An unnamed candidate'}</div>
          <div className="plaque-title">{profile.title.trim() || 'Thesis to be announced by the committee'}</div>
        </div>
      </div>

      <section className="page dossier">
        <div className="page-body">
          <h2>Your Dossier</h2>
          {ornament}
          <label className="field">
            <span className="label">
              Name <em>(needed)</em>
            </span>
            <input value={profile.name} maxLength={40} placeholder="Dr. …" onChange={(e) => update({ ...profile, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Thesis</span>
            <input value={profile.title} maxLength={160} placeholder="Leave it empty and the committee writes one" onChange={(e) => update({ ...profile, title: e.target.value })} onBlur={() => net.setProfile(profile)} />
          </label>
          <label className="field">
            <span className="label">Voice</span>
            <select value={profile.voice ?? ''} onChange={(e) => update({ ...profile, voice: VOICES.find((v) => v === e.target.value) ?? null }, true)}>
              <option value="">{net.ownVoice ? `Your own: ${voiceName(net.ownVoice)}` : 'Your own'}</option>
              {VOICE_LIST.map((v) => (
                <option key={v} value={v}>
                  {voiceName(v)}
                </option>
              ))}
            </select>
          </label>
          <div className="note-inline voice-hint">
            Press <kbd>V</kbd> to hear it. Everyone hears it too.
          </div>
          <label className="field">
            <span className="label">What will you bring to your defence?</span>
            <input value={bring} maxLength={400} disabled={bringing !== 'none' && bringing !== 'queued'} placeholder="A thing, in your own words; leave it empty for a surprise" onChange={(e) => writeBring(e.target.value)} />
          </label>
          <div className="note-inline bring-state">{BRINGING[bringing]}</div>

          <h3>Appearance</h3>
          <label className="field">
            <span className="label">Say how you look, and the tailor makes it</span>
            <div className="ask">
              <textarea
                value={ask}
                maxLength={300}
                rows={2}
                placeholder="Hair, a hat, a beard, a cape, the coat's colour…"
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendAsk()
                  }
                }}
              />
              <button onClick={sendAsk} disabled={!ask.trim() || me?.dressing}>
                {me?.dressing ? 'Making…' : 'Make it'}
              </button>
            </div>
          </label>
          {note && <div className="note-inline">{note}</div>}

          <div className="measures">
            <label className="measure">
              <span className="label">
                Height <b>{profile.look.height.toFixed(2)} m</b>
              </span>
              <input type="range" min={1.5} max={2.05} step={0.01} value={profile.look.height} onChange={(e) => setLook({ height: Number(e.target.value) })} />
            </label>
            <label className="measure">
              <span className="label">
                Build <b>{buildName(profile.look.build)}</b>
              </span>
              <input type="range" min={0.8} max={1.3} step={0.01} value={profile.look.build} onChange={(e) => setLook({ build: Number(e.target.value) })} />
            </label>
            <label className="measure">
              <span className="label">Walk</span>
              <select value={profile.look.gait ?? 'chance'} onChange={(e) => setLook({ gait: e.target.value as Gait })}>
                {GAITS.map((g) => (
                  <option key={g} value={g}>
                    {GAIT_NAMES[g]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="colours">
            {COLOURS.map(([k, label]) => (
              <label key={k} className="swatch">
                <input type="color" value={profile.look[k] as string} onChange={(e) => setLook({ [k]: e.target.value })} />
                {label}
              </label>
            ))}
          </div>

          <h3>Wardrobe</h3>
          <div className="slots">
            {SLOTS.map((s) => (
              <button key={s} className={s === slot ? 'on' : ''} onClick={() => setSlot(s)}>
                {SLOT_NAMES[s]}
              </button>
            ))}
          </div>
          <div className="parts">
            <button className={!profile.look.worn[slot] ? 'on nothing' : 'nothing'} onClick={() => wear(slot, null)}>
              Nothing
            </button>
            {parts.map((p) => (
              <button key={p.id} className={profile.look.worn[slot] === p.id ? 'on' : ''} title={p.ask ? `${p.by}: “${p.ask}”` : 'The game’s own'} onClick={() => wear(slot, p.id)}>
                <span>
                  {p.name}
                  <small>{p.by ? `by ${p.by}` : 'the game’s own'}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer className="dress-bar">
        <div className="next">
          {lobby.timer !== null && <span className="timer">The round starts in {lobby.timer} s, ready or not</span>}
          {lobby.round > 0 ? `Round ${lobby.round} played · the first to win ${lobby.wins} takes the doctorate` : `The first to win ${lobby.wins} rounds takes the doctorate`}
        </div>
        {!profile.name.trim() && <span className="ready-hint">Write your name to be ready</span>}
        <button className="small" onClick={() => net.send({ type: 'taunt' })}>
          Taunt <kbd>V</kbd>
        </button>
        <button
          className={`primary big ${me?.ready ? 'on' : ''}`}
          disabled={!profile.name.trim()}
          onClick={() => {
            net.setProfile(profile)
            // The words as they are now go first: Ready starts what they bring being made.
            if (bringTimer.current) clearTimeout(bringTimer.current)
            net.send({ type: 'bring', text: bring })
            net.send({ type: 'ready', ready: !me?.ready })
            play('start', 1)
          }}
        >
          {me?.ready ? 'Ready ✓' : 'Ready'}
        </button>
      </footer>
    </div>
  )
}
