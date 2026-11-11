/**
 * A round as the player sees it: the first-person view and the HUD over it (credibility, what
 * is in hand and how it came, the request line, the review on their next request, the feed of
 * crates opened and who was dismissed by whom, who just hurt them and from where, the
 * committee's patience) and the request box. T (or Enter) opens the box: the doctor stops and
 * writes while everyone else goes on (in the countdown too); Enter sends it, Escape gives up.
 * Dismissed, T opens the box for one review a round of the doctor they watch.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PerspectiveCamera } from 'three'

import { Controls } from './controls'
import type { Net } from './net'
import { openOptions, options as currentOptions, pixelRatio, useOptions, useOptionsOpen } from './options'
import { BARE_HANDS, BUDGET_WINDOW, CRATE_OWNER_ONLY, FISTS_BUDGET, HEARING, PATIENCE, PATIENCE_DRAIN, type GameEvent, type Lobby, type Origin } from './protocol'
import { Post } from './scene/post'
import { World } from './scene/world'
import { play, wakeAudio } from './sounds'

interface FeedLine {
  id: number
  text: string
  until: number
  tone: 'out' | 'crate' | 'curse' | 'plain'
}

/** The box open: a request, or a review of the doctor watched. */
type Writing = { kind: 'request' } | { kind: 'review'; target: string }

/** The marks at the screen's edge pointing to whoever hurt the player, at most this many. */
const MARKS = 3

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** A crate opened, as the feed tells it: who opened it (and whose it was), what was asked and what came (made as something else because it was had already this match, twisted by the genie, or from the archive in its place), and the review it was under. */
function crateStory(e: Extract<GameEvent, { type: 'opened' }>, name: (id: string) => string): string {
  const who = e.by === e.owner ? name(e.by) : `${name(e.by)} took ${name(e.owner)}'s crate`
  const what = e.archive ? `${e.thing}, from the archive${e.ask === null ? '' : ` in place of “${e.ask}”`}` : e.ask === null ? `${e.thing}, something nobody has had` : `“${e.ask}” became ${e.thing}`
  return [`${who}: ${what}.`, ...(e.again ? [`${e.again} was had already this match.`] : []), ...(e.genie ? ['The genie twisted it.'] : []), ...(e.curse ? [`Under review: “${short(e.curse, 60)}”`] : [])].join(' ')
}

/** How a thing in hand came out of its crate: who asked for what, and whether it was had already this match, the genie twisted it or the archive stood in. */
function originLine(o: Origin, you: string | null, name: (id: string) => string): string {
  if (o.archive) return o.ask === null ? 'From the archive' : `From the archive, in place of “${o.ask}”`
  const who = o.by === you ? 'You' : name(o.by)
  return o.ask === null ? `${who} asked for something nobody has had` : `${who} asked for “${o.ask}”${o.again ? `; ${o.again} was had already this match` : ''}${o.genie ? '; the genie twisted it' : ''}`
}

function Scene({ net, controls, worldRef, fps, marks }: { net: Net; controls: Controls; worldRef: React.MutableRefObject<World | null>; fps: React.RefObject<HTMLDivElement | null>; marks: React.RefObject<HTMLDivElement | null> }) {
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
    // The marks toward whoever hurt the player turn with the view every frame (the HUD's own beat is too slow for a turning camera).
    const hurt = w.own?.alive ? w.attackers() : []
    marks.current!.childNodes.forEach((el, i) => {
      const style = (el as HTMLElement).style
      const a = hurt[i]
      style.opacity = a ? a.strength.toFixed(2) : '0'
      if (a) style.transform = `rotate(${a.turn.toFixed(3)}rad)`
    })
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
  const [writing, setWriting] = useState<Writing | null>(null)
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
  const writingRef = useRef<Writing | null>(null)
  const phaseRef = useRef(lobby.phase)
  phaseRef.current = lobby.phase
  const crosshair = useRef<HTMLDivElement>(null)
  const marks = useRef<HTMLDivElement>(null)
  /** The last hit on the player, for the slip under the crosshair: by whom, with what, how much (added up while it goes on). */
  const struck = useRef<{ by: string | null; what: string; amount: number; until: number } | null>(null)
  /** What the player's things (and bare hands) have taken all they may from, and until when: on the hand cards. */
  const spent = useRef(new Map<string, { victim: string; until: number }>())
  /** A word from the page itself, for a moment. */
  const pageNote = useRef<{ text: string; until: number } | null>(null)
  /** When the last hit by the player ticked. */
  const ticked = useRef(0)
  const name = (id: string) => net.player(id)?.name ?? 'someone'

  /** Whom the player may review now: dismissed in a round with a review left, the doctor they watch, unless a bot (bots ask for nothing). */
  const reviewTarget = (): string | null => {
    const w = worldRef.current
    const id = w?.watching
    return w?.own && !w.own.alive && phaseRef.current === 'round' && net.me?.review && id && net.player(id)?.bot === false ? id : null
  }
  const openWriting = () => {
    if (writingRef.current) return
    const w = worldRef.current
    const phase = phaseRef.current
    const target = reviewTarget()
    let mode: Writing
    if (w?.own?.alive && (phase === 'round' || phase === 'countdown')) mode = { kind: 'request' }
    else if (target) mode = { kind: 'review', target }
    else return
    writingRef.current = mode
    setWriting(mode)
    if (mode.kind === 'request') net.send({ type: 'writing', on: true })
    setTimeout(() => input.current?.focus(), 0)
  }
  const closeWriting = (send: boolean) => {
    const t = text.trim()
    const mode = writingRef.current!
    writingRef.current = null
    setWriting(null)
    setText('')
    if (mode.kind === 'request') net.send({ type: 'writing', on: false })
    if (send && t) {
      net.send(mode.kind === 'request' ? { type: 'request', text: t } : { type: 'review', target: mode.target, text: t })
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
    const push = (text: string, tone: FeedLine['tone']) => setFeed((f) => [...f.filter((l) => l.until > performance.now()), { id: ++feedId.current, text, until: performance.now() + 7000, tone }].slice(-7))
    return net.onEvent((e: GameEvent) => {
      const now = performance.now()
      if (e.type === 'out') push(e.by && e.by !== 'committee' ? `${name(e.victim)} was dismissed by ${name(e.by)} (${e.what})` : `${name(e.victim)} was dismissed by ${e.what}`, 'out')
      else if (e.type === 'opened') push(crateStory(e, name), 'crate')
      else if (e.type === 'fizzle') push(`${e.thing} fizzled out`, 'plain')
      else if (e.type === 'curse') push(e.by ? `${name(e.victim)} is under review by ${name(e.by)}` : `${name(e.victim)} is under review`, 'curse')
      else if (e.type === 'hit' && e.victim === net.you) {
        // Who hurt the player, with what: one slip while the same goes on.
        const was = struck.current
        const same = was && was.until > now && was.by === e.by && was.what === e.what
        struck.current = { by: e.by, what: e.what, amount: (same ? was.amount : 0) + e.amount, until: now + 2000 }
      } else if (e.type === 'hit' && e.by === net.you) {
        // A hit landed: the crosshair pulses and ticks.
        crosshair.current?.animate([{ transform: 'scale(1.7)', borderColor: '#ff8a66' }, { transform: 'scale(1)' }], { duration: 250, easing: 'ease-out' })
        if (now - ticked.current > 70) {
          ticked.current = now
          play('click', 1.7, null, 0.5)
        }
      } else if (e.type === 'spent' && e.by === net.you) spent.current.set(e.thing, { victim: e.victim, until: now + e.back * 1000 })
      else if (e.type === 'notYet' && e.who === net.you) pageNote.current = { text: `Only ${name(e.owner)} may open it, for ${e.secs} s more.`, until: now + 2500 }
      else if (e.type === 'usedUp' && e.who === net.you) pageNote.current = { text: `${e.thing} is used up. T asks for something new.`, until: now + 3000 }
    })
  }, [net])

  // The round's end, and the match's, are heard.
  useEffect(() => {
    if (lobby.phase === 'roundEnd' && lobby.winner) play('win', 1)
    if (lobby.phase === 'matchEnd') play('win', 0.75)
  }, [lobby.phase, lobby.winner])

  const snap = net.latest()?.snap
  const me = net.me
  const own = snap?.doctors.find((d) => d.id === net.you) ?? null
  const patience = snap ? PATIENCE - snap.t : PATIENCE
  const now = performance.now()
  const note = (pageNote.current && pageNote.current.until > now ? pageNote.current.text : null) ?? me?.note ?? (net.note && net.note.until > now ? net.note.text : null)
  const hit = struck.current && struck.current.until > now ? struck.current : null
  const watched = worldRef.current?.watching ? net.player(worldRef.current.watching)?.name : null

  return (
    <div className="round" ref={holder}>
      <Canvas shadows="percentage" dpr={pixelRatio(currentOptions())} gl={{ antialias: false, powerPreference: 'high-performance' }} camera={{ fov: currentOptions().fov, near: 0.08, far: 400 }} onPointerDown={() => wakeAudio()}>
        {controls && <Scene net={net} controls={controls} worldRef={worldRef} fps={fps} marks={marks} />}
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
      {own?.alive && <div ref={crosshair} className={own.fx?.held ? 'crosshair held' : 'crosshair'} />}
      {own?.alive && own.fx?.held && <div className="held-note">Held</div>}
      {own?.alive && hit && (
        <div className="hit-slip plate">
          {hit.by === null || hit.by === 'committee' ? hit.what.slice(0, 1).toUpperCase() + hit.what.slice(1) : `${name(hit.by)} · ${hit.what}`} · −{Math.round(hit.amount * 10) / 10}
        </div>
      )}

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

      {/* Beside a review's slip, the feed keeps to the right of it. */}
      <div className={me?.curse && own?.alive ? 'feed beside-slip' : 'feed'}>
        {feed
          .filter((l) => l.until > now)
          .map((l) => (
            <div key={l.id} className={`feed-line plate ${l.tone}`}>
              {l.text}
            </div>
          ))}
      </div>

      {/* Along the foot: credibility, then what is said and a word to this player between the plates (never under them), then the hands. */}
      <div className="hud-bottom">
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
        <div className="hud-middle">
          {said
            .filter((l) => l.until > now)
            .map((l) => (
              <div key={l.id} className="said-line plate">
                <b>{l.who}:</b> “{l.text}”
              </div>
            ))}
          {note && <div className="note slip page">{note}</div>}
        </div>
        {own && own.alive && me && (
          <div className="hud-right">
            {([0, 1] as const).map((h) => {
              const held = me.hands[h]
              // What this hand has taken all it may from, and for how long yet.
              const gone = spent.current.get(held ? held.name : BARE_HANDS)
              const left = gone ? Math.ceil((gone.until - now) / 1000) : 0
              return (
                <div key={h} className={held ? 'hand-card plate' : 'hand-card plate empty'}>
                  <div className="label">{h === 0 ? 'Left hand · left button' : 'Right hand · right button'}</div>
                  {held ? (
                    <>
                      <div className="held-name">
                        {held.name}
                        <span className={held.left <= 2 ? 'held-left low' : 'held-left'}>{held.left === 1 ? '1 use left' : `${held.left} uses left`}</span>
                      </div>
                      {held.origin && <div className="held-origin">{originLine(held.origin, net.you, name)}</div>}
                      <div className="held-desc">{asTwoHanded(held.description)}</div>
                      <div className="held-budget">
                        At most {held.budget} from each in {BUDGET_WINDOW} s · <kbd>{h === 0 ? 'Q' : 'F'}</kbd> throws it
                      </div>
                    </>
                  ) : (
                    <div className="held-desc">
                      Empty: it shoves, at most {FISTS_BUDGET} from each in {BUDGET_WINDOW} s · <kbd>E</kbd> picks up
                    </div>
                  )}
                  {gone && left > 0 && (
                    <div className="held-spent">
                      Spent on {name(gone.victim)} for {left} s
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {me?.curse && own?.alive && (
        <div className="curse slip page">
          <span className="label">{me.curse.by ? `Under review by ${name(me.curse.by)}` : 'Under review'}</span>
          {me.curse.text}
        </div>
      )}

      {/* Toward whoever hurt the player, over the slips: turned by the frame loop (Scene). */}
      <div className="hit-marks" ref={marks}>
        {Array.from({ length: MARKS }, (_, i) => (
          <i key={i} />
        ))}
      </div>

      {own && !own.alive && lobby.phase === 'round' && (
        <div className="spectating plate">
          <b>Dismissed.</b>{' '}
          {!watched ? (
            'The committee watches on.'
          ) : reviewTarget() ? (
            <>
              Watching {watched}. <kbd>T</kbd> reviews their next request; click for the next.
            </>
          ) : (
            `Watching ${watched}; click for the next.`
          )}
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
            <h2>{writing.kind === 'review' ? `Review ${name(writing.target)}'s next request` : 'What do you need?'}</h2>
            <p className="lede">{writing.kind === 'review' ? 'One review a round. The designer follows it before reading their words.' : 'Anything at all, but nothing had already this match. You stand still while you write, so be quick.'}</p>
            <input
              ref={input}
              value={text}
              maxLength={writing.kind === 'review' ? 200 : 400}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeWriting(false)
                }
                e.stopPropagation()
              }}
              placeholder={writing.kind === 'review' ? 'What the committee demands, in your own words' : 'A thing, in your own words'}
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
                <div className="hint">
                  Each mouse button works its own hand; an empty one shoves, at most {FISTS_BUDGET} from each in {BUDGET_WINDOW} s.
                </div>
                <div className="hint">Everyone's first crate waits beside them as the round begins. A crate is its asker's alone for {CRATE_OWNER_ONLY} s once ready, then anyone's.</div>
                <div className="hint">Every thing has its own count of uses, on its card, and is gone when they are spent. Nothing comes twice in a match: words asking for a thing had already become something else.</div>
                <div className="hint">
                  Dismissed, you may review a player you watch (not a bot), once a round (<kbd>T</kbd>): it bends their next request.
                </div>
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
  // A page here without a name only watches: it plays no round and has no row.
  const players = lobby.players.filter((p) => p.name).sort((a, b) => b.wins - a.wins)
  return (
    <div className="scores page">
      <div className="page-body">
        <h2>The Standings</h2>
        <p className="lede">The first to win {lobby.wins} rounds takes the doctorate</p>
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
