/**
 * A round as the player sees it: the first-person view and the HUD over it (credibility, what
 * is in hand, the request line, the curse, the feed of who was dismissed by whom, the
 * committee's patience) and the request box. T (or Enter) opens the box: the doctor stops and
 * writes while everyone else goes on; Enter sends it, Escape gives up.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PerspectiveCamera } from 'three'

import { Controls } from './controls'
import type { Net } from './net'
import { openOptions, options as currentOptions, pixelRatio, useOptions, useOptionsOpen } from './options'
import { BUDGET_WINDOW, HEARING, PATIENCE, PATIENCE_DRAIN, type GameEvent, type Lobby } from './protocol'
import { Post } from './scene/post'
import { World } from './scene/world'
import { play, wakeAudio } from './sounds'

interface FeedLine {
  id: number
  text: string
  until: number
  tone: 'out' | 'crate' | 'curse' | 'plain'
}

function Scene({ net, controls, worldRef, fps }: { net: Net; controls: Controls; worldRef: React.MutableRefObject<World | null>; fps: React.RefObject<HTMLDivElement | null> }) {
  const o = useOptions()
  const { scene, camera, gl, size, setDpr } = useThree()
  const aligned = useRef<string | null>(null)
  // The drawing's resolution and the field of view follow the options at once.
  const dpr = pixelRatio(o)
  useEffect(() => setDpr(dpr), [setDpr, dpr])
  useEffect(() => {
    const c = camera as PerspectiveCamera
    c.fov = o.fov
    c.updateProjectionMatrix()
  }, [camera, o.fov])
  // The world is built again when what it is built with changes.
  const { lamps, dust, shadows } = o
  useEffect(() => {
    const w = new World(scene, camera as PerspectiveCamera, net, gl, {
      lamps,
      dust,
      shadows,
    })
    worldRef.current = w
    return () => {
      w.dispose()
      worldRef.current = null
    }
  }, [scene, camera, net, worldRef, gl, lamps, dust, shadows])
  // The finishing passes: the grade always (it is the look), the others as the options say.
  const post = useMemo(() => new Post(gl, scene, camera, { ao: o.ao, bloom: o.bloom, antialias: o.antialias }, size.width, size.height), [gl, scene, camera, o.ao, o.bloom, o.antialias])
  useEffect(() => post.setSize(size.width, size.height), [post, size, dpr])
  useEffect(() => post.setSharpen(o.sharpen), [post, o.sharpen])
  useEffect(() => () => post.dispose(), [post])
  // Drawing is this game's own from here: through the finishing passes.
  const frames = useRef({ n: 0, since: 0 })
  useFrame((_, dt) => {
    post.render(dt)
    // The frame counter, twice a second.
    const f = frames.current
    const now = performance.now()
    f.n++
    if (now - f.since >= 500) {
      if (fps.current) fps.current.textContent = `${Math.round((f.n * 1000) / (now - f.since))} fps · ${Math.round(size.width * dpr)} × ${Math.round(size.height * dpr)}`
      f.n = 0
      f.since = now
    }
  }, 1)
  useFrame((_, dt) => {
    const w = worldRef.current
    if (!w) return
    // A new round turns the view to where the doctor was put.
    const arena = net.arena?.id ?? null
    if (aligned.current !== arena) {
      const own = net.latest()?.snap.doctors.find((d) => d.id === net.you)
      if (own) {
        controls.yaw = own.yaw
        controls.pitch = 0
        aligned.current = arena
      }
    }
    w.update(controls, Math.min(dt, 0.1))
    controls.watching = !(w.own?.alive ?? false)
    if (aligned.current === arena) net.sendInput(controls.input())
  })
  return null
}

/** How to play, on the pause card: what, and the keys. */
const KEYS: [string, React.ReactNode][] = [
  [
    'Move',
    <>
      <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>
    </>,
  ],
  ['Look', 'the mouse'],
  ['Jump', <kbd>Space</kbd>],
  ['Use what is in a hand', 'left or right button'],
  [
    'Its other use',
    <>
      <kbd>Shift</kbd> + click
    </>,
  ],
  ['Pick up, open a crate', <kbd>E</kbd>],
  [
    'Throw from the left, the right',
    <>
      <kbd>Q</kbd> <kbd>F</kbd>
    </>,
  ],
  ['Ask for anything', <kbd>T</kbd>],
  ['Something nobody has had', <kbd>R</kbd>],
  ['Taunt', <kbd>V</kbd>],
  ['The scores', <kbd>Tab</kbd>],
  ['Options', <kbd>O</kbd>],
]

/** A thing's line as its designer wrote it, said for two hands: what was the right click is now Shift with the click of its hand. */
function asTwoHanded(line: string): string {
  return line.replace(/\bright[- ]?click(s|ing|ed)?\b/gi, (_m, end: string | undefined) => `shift-click${end ?? ''}`).replace(/^shift/, 'Shift')
}

export function Round({ net, lobby }: { net: Net; lobby: Lobby }) {
  const holder = useRef<HTMLDivElement>(null)
  const worldRef = useRef<World | null>(null)
  const [controls, setControls] = useState<Controls | null>(null)
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [scores, setScores] = useState(false)
  const [, setBeat] = useState(0)
  const [feed, setFeed] = useState<FeedLine[]>([])
  /** Taunts heard lately, shown as subtitles whether or not this browser can say them. */
  const [said, setSaid] = useState<{ id: number; who: string; text: string; until: number }[]>([])
  const [locked, setLocked] = useState(false)
  const shown = useOptions()
  // With the options open the pause card steps aside (the picture stays clear to tune the lighting); a click in the picture still takes up the game.
  const optionsOpen = useOptionsOpen()
  const fps = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const feedId = useRef(0)
  const writingRef = useRef(false)
  const phaseRef = useRef(lobby.phase)
  phaseRef.current = lobby.phase

  const openWriting = () => {
    if (writingRef.current) return
    const own = worldRef.current?.own
    if (!own?.alive || phaseRef.current !== 'round') return
    writingRef.current = true
    setWriting(true)
    net.send({ type: 'writing', on: true })
    setTimeout(() => input.current?.focus(), 0)
  }
  const closeWriting = (send: boolean) => {
    const t = text.trim()
    writingRef.current = false
    setWriting(false)
    setText('')
    net.send({ type: 'writing', on: false })
    if (send && t) {
      net.send({ type: 'request', text: t })
      play('ui', 1.2)
    }
    input.current?.blur()
  }

  useEffect(() => {
    const c = new Controls(holder.current!, {
      write: openWriting,
      random: () => {
        net.send({ type: 'random' })
        play('ui', 0.9)
      },
      taunt: () => net.send({ type: 'taunt' }),
      scores: setScores,
      next: () => worldRef.current?.watchNext(),
    })
    setControls(c)
    const onLock = () => setLocked(c.locked)
    document.addEventListener('pointerlockchange', onLock)
    const beat = setInterval(() => setBeat((b) => b + 1), 100)
    return () => {
      document.removeEventListener('pointerlockchange', onLock)
      clearInterval(beat)
      c.dispose()
    }
    // The callbacks read refs and the net; they need not be renewed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net])

  useEffect(
    () =>
      net.onTaunt((t) => {
        const ear = worldRef.current?.ear() ?? null
        if (t.at && ear && t.by !== net.you && Math.hypot(t.at[0] - ear[0], t.at[1] - ear[1], t.at[2] - ear[2]) > HEARING) return
        const now = performance.now()
        setSaid((list) => [
          ...list.filter((l) => l.until > now).slice(-2),
          {
            id: t.when,
            who: net.player(t.by)?.name ?? 'Someone',
            text: t.text,
            until: now + 4000 + t.text.length * 60,
          },
        ])
      }),
    [net],
  )

  useEffect(() => {
    const name = (id: string | null) => (id ? (net.player(id)?.name ?? 'someone') : 'the arena')
    const push = (text: string, tone: FeedLine['tone']) => setFeed((f) => [...f.filter((l) => l.until > performance.now()), { id: ++feedId.current, text, until: performance.now() + 7000, tone }].slice(-7))
    return net.onEvent((e: GameEvent) => {
      if (e.type === 'out') push(e.by && e.by !== 'committee' ? `${name(e.victim)} was dismissed by ${name(e.by)} (${e.what})` : `${name(e.victim)} was dismissed by ${e.what}`, 'out')
      else if (e.type === 'opened') push(`${name(e.by)} opened a crate: ${e.thing}`, 'crate')
      else if (e.type === 'fizzle') push(`${e.thing} fizzled out`, 'plain')
      else if (e.type === 'curse') push(`${name(e.victim)} is cursed`, 'curse')
    })
  }, [net])

  const snap = net.latest()?.snap
  const me = net.me
  const own = snap?.doctors.find((d) => d.id === net.you) ?? null
  const patience = snap ? PATIENCE - snap.t : PATIENCE
  const now = performance.now()
  const note = me?.note ?? (net.note && net.note.until > now ? net.note.text : null)
  const watched = worldRef.current?.watching ? net.player(worldRef.current.watching)?.name : null

  return (
    <div className="round" ref={holder}>
      <Canvas shadows dpr={pixelRatio(currentOptions())} gl={{ antialias: false, powerPreference: 'high-performance' }} camera={{ fov: currentOptions().fov, near: 0.08, far: 400 }} onPointerDown={() => wakeAudio()}>
        {controls && <Scene net={net} controls={controls} worldRef={worldRef} fps={fps} />}
      </Canvas>
      {shown.fps && <div className="fps" ref={fps} />}

      {own?.alive && own.fx?.glow && <div className={`glow-veil${own.fx.shake > 0.3 ? ' flicker' : ''}`} style={{ boxShadow: `inset 0 0 160px 40px ${own.fx.glow}` }} />}
      {own?.alive && own.hurt < 0.5 && <div className="hurt-veil" style={{ opacity: 1 - own.hurt / 0.5 }} />}
      {own?.alive && own.fx && own.fx.blind > 0 && (
        <div
          className="blind-veil"
          style={{
            background: own.fx.tint ?? '#0c0a08',
            opacity: own.fx.blind,
          }}
        />
      )}
      {own?.alive && <div className={own.fx?.held ? 'crosshair held' : 'crosshair'} />}
      {own?.alive && own.fx?.held && <div className="held-note">Held</div>}

      <div className="hud-top">
        {lobby.phase === 'round' && (
          <div className={`patience plate ${patience <= 0 ? 'lost' : ''}`}>
            {patience > 0 ? (
              <>
                The committee's patience <b>{`${Math.floor(patience / 60)}:${String(Math.floor(patience % 60)).padStart(2, '0')}`}</b>
              </>
            ) : (
              `The committee has lost patience: −${PATIENCE_DRAIN} a second`
            )}
          </div>
        )}
      </div>

      <div className="feed">
        {feed
          .filter((l) => l.until > now)
          .map((l) => (
            <div key={l.id} className={`feed-line plate ${l.tone}`}>
              {l.text}
            </div>
          ))}
      </div>

      {own && own.alive && (
        <div className="hud-left plate">
          <div className="cred-head">
            <span className="label">Credibility</span>
            <span className="cred-num">{Math.ceil(own.cred)}</span>
          </div>
          <div className="cred-bar">
            <div
              className="cred-fill"
              style={{
                width: `${own.cred}%`,
                background: own.cred > 50 ? 'linear-gradient(180deg, #ecd796, #c9a752)' : own.cred > 25 ? 'linear-gradient(180deg, #f0b45a, #c97f2a)' : 'linear-gradient(180deg, #ee6a52, #b8342a)',
              }}
            />
          </div>
          <div className="ask-line">
            {me?.crate ? (
              'Your crate is on its way'
            ) : me && me.cooldown > 0 ? (
              `Next request in ${Math.ceil(me.cooldown)} s`
            ) : (
              <>
                <kbd>T</kbd> ask for anything · <kbd>R</kbd> something nobody has had
              </>
            )}
          </div>
        </div>
      )}

      {own && own.alive && me && (me.hands[0] || me.hands[1]) && (
        <div className="hud-right">
          {([0, 1] as const).map((h) => {
            const held = me.hands[h]
            return (
              <div key={h} className={held ? 'hand-card plate' : 'hand-card plate empty'}>
                <div className="label">{h === 0 ? 'Left hand · left button' : 'Right hand · right button'}</div>
                {held ? (
                  <>
                    <div className="held-name">{held.name}</div>
                    <div className="held-desc">{asTwoHanded(held.description)}</div>
                    <div className="held-budget">
                      At most {held.budget} from each in {BUDGET_WINDOW} s · <kbd>{h === 0 ? 'Q' : 'F'}</kbd> throws it
                    </div>
                  </>
                ) : (
                  <div className="held-desc">
                    Empty: it shoves · <kbd>E</kbd> picks up
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {me?.curse && own?.alive && (
        <div className="curse slip page">
          <span className="label">Cursed</span>
          {me.curse}
        </div>
      )}

      {note && <div className="note slip page">{note}</div>}

      <div className="said">
        {said
          .filter((l) => l.until > now)
          .map((l) => (
            <div key={l.id} className="said-line plate">
              <b>{l.who}:</b> “{l.text}”
            </div>
          ))}
      </div>

      {own && !own.alive && lobby.phase === 'round' && (
        <div className="spectating plate">
          <b>Dismissed.</b> {watched ? `Watching ${watched}; click for the next.` : 'The committee watches on.'}
        </div>
      )}

      {writing && (
        <form
          className="request page"
          onSubmit={(e) => {
            e.preventDefault()
            closeWriting(true)
          }}
        >
          <div className="page-body">
            <h2>What do you need?</h2>
            <p className="lede">Anything at all. You stand still while you write, so be quick.</p>
            <input
              ref={input}
              value={text}
              maxLength={400}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeWriting(false)
                }
                e.stopPropagation()
              }}
              placeholder="A thing, in your own words"
            />
            <div className="hint">
              <kbd>Enter</kbd> sends it · <kbd>Esc</kbd> gives up
            </div>
          </div>
        </form>
      )}

      {lobby.phase === 'countdown' && <div className="big-center">{lobby.timer ?? ''}</div>}
      {lobby.phase === 'roundEnd' && (
        <div className="big-center small">
          <div className="banner">
            {lobby.winner ? (
              <>
                Thesis accepted
                <div className="sub">{lobby.winner}</div>
              </>
            ) : (
              'Nobody convinced the committee'
            )}
          </div>
        </div>
      )}
      {lobby.phase === 'matchEnd' && (
        <div className="big-center small">
          <div className="banner">
            The doctorate is awarded to
            <div className="sub">{lobby.winner}</div>
          </div>
        </div>
      )}

      {(scores || lobby.phase === 'roundEnd' || lobby.phase === 'matchEnd') && <Scores net={net} lobby={lobby} />}

      {!locked && !writing && (lobby.phase === 'round' || lobby.phase === 'countdown') && (
        <div
          className={optionsOpen ? 'click-to-play clear' : 'click-to-play'}
          onClick={() => {
            wakeAudio()
            controls?.lock()
          }}
        >
          <div className="card page">
            <div className="page-body">
              <h2>{lobby.phase === 'countdown' && lobby.timer !== null ? `The defence begins in ${lobby.timer}` : own && !own.alive ? 'Click to watch the others' : 'Click to defend your thesis'}</h2>
              <div className="ornament">
                <i />
              </div>
              <dl className="keys">
                {KEYS.map(([what, keys]) => (
                  <div key={what}>
                    <dt>{what}</dt>
                    <dd>{keys}</dd>
                  </div>
                ))}
              </dl>
              <div className="card-foot">
                <button
                  className="primary"
                  onClick={(e) => {
                    e.stopPropagation()
                    wakeAudio()
                    controls?.lock()
                  }}
                >
                  Play
                </button>
                <button
                  className="options-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openOptions()
                  }}
                >
                  Options <kbd>O</kbd>
                </button>
                {lobby.players.find((p) => p.id === net.you)?.chair && lobby.phase === 'round' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      net.send({ type: 'endRound' })
                    }}
                  >
                    End this round
                  </button>
                )}
                <div className="hint">A thing in each hand: each mouse button works its own hand, and an empty hand shoves.</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Scores({ net, lobby }: { net: Net; lobby: Lobby }) {
  const snap = net.latest()?.snap
  const players = [...lobby.players].sort((a, b) => b.wins - a.wins)
  return (
    <div className="scores page">
      <div className="page-body">
        <h2>The Standings</h2>
        <div className="ornament">
          <i />
        </div>
        <table>
          <thead>
            <tr>
              <th>Doctor</th>
              <th>Thesis</th>
              <th className="num">Credibility</th>
              <th className="num">Rounds</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const d = snap?.doctors.find((x) => x.id === p.id)
              return (
                <tr key={p.id} className={p.id === net.you ? 'you' : ''}>
                  <td className="who">
                    <span className="dot" style={{ background: p.color }} />
                    {p.name}
                  </td>
                  <td className="title">{p.title}</td>
                  <td className={d && !d.alive ? 'num out' : 'num'}>{d ? (d.alive ? Math.ceil(d.cred) : 'dismissed') : '–'}</td>
                  <td className="num">{p.wins}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
