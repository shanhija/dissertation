/**
 * The options screen, over whatever is showing: from the dressing room's button, the pause card's,
 * or O at any time (Esc or O again closes it). Two tabs: the player's options (controls, display,
 * graphics, sound) and the lighting and the look, to tune live (docked at the side, the picture
 * undimmed, so what changes can be seen) and send on as the game's own. Every change takes at once
 * and is kept in this browser. Clicks here never reach what is under it (the round's card would
 * take the mouse for the game).
 */

import { useEffect, useState } from 'react'

import { LIGHTING, RANGES, lightingText, setLighting, useLighting, type Lighting } from './lighting'

import { canFullscreen, closeOptions, defaults, isFullscreen, pixelRatio, setOptions, toggleFullscreen, useOptions, useOptionsOpen, type Antialias, type Options, type Quality, type Shadows } from './options'

const DEFAULT_SENSITIVITY = defaults().sensitivity

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="option">
      <span className="option-label">
        {label}
        {hint && <span className="option-hint">{hint}</span>}
      </span>
      <span className="option-control">{children}</span>
    </label>
  )
}

function Slider({ value, min, max, step, show, onChange }: { value: number; min: number; max: number; step: number; show: string; onChange: (v: number) => void }) {
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="option-value">{show}</span>
    </>
  )
}

function Check({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
}

/** The lighting tab's rows: what each is called, a word on it, and how its number reads. */
const LIGHT_ROWS: {
  title: string
  rows: [keyof Lighting, string, string | null, (v: number) => string][]
}[] = [
  {
    title: 'Light',
    rows: [
      ['exposure', 'Exposure', 'Everything brighter or darker', (v) => `${v.toFixed(2)}×`],
      ['ambient', 'Ambient', "The sky's light from all round", (v) => v.toFixed(2)],
      ['reflections', 'Reflections', 'What shiny things reflect', (v) => v.toFixed(2)],
      ['sun', 'Sun', null, (v) => v.toFixed(1)],
      ['sunHeight', 'Sun height', null, (v) => `${v}°`],
      ['sunTurn', 'Sun direction', null, (v) => `${v}°`],
      ['sunWarmth', 'Sun warmth', 'Cold blue to low gold', (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))],
      ['lamps', 'Lamps', "The arena's own", (v) => `${v.toFixed(2)}×`],
      ['lampReach', 'Lamp reach', null, (v) => `${v.toFixed(2)}×`],
      ['effectLight', 'Light from effects', 'Fire, flashes, glowing sights', (v) => `${v.toFixed(2)}×`],
      ['glow', 'Glowing shapes', null, (v) => `${v.toFixed(2)}×`],
    ],
  },
  {
    title: 'Finishing',
    rows: [
      ['ao', 'Ambient occlusion', 'With it on in Graphics', (v) => v.toFixed(2)],
      ['bloom', 'Bloom strength', 'With it on in Graphics', (v) => v.toFixed(2)],
      ['bloomThreshold', 'Bloom threshold', 'How bright before it glows', (v) => v.toFixed(2)],
    ],
  },
  {
    title: 'The book',
    rows: [
      ['bands', 'Light bands', 'Smooth to light, mid and dark', (v) => `${Math.round(v * 100)}%`],
      ['hatching', 'Hatching', 'Engraved lines in the shadows', (v) => `${Math.round(v * 100)}%`],
      ['hatchSize', 'Hatching size', 'How far apart the lines are', (v) => `${v.toFixed(1)}×`],
      ['dust', 'Dust', 'Settled on what faces up', (v) => `${Math.round(v * 100)}%`],
      ['grain', 'Paper grain', null, (v) => `${Math.round(v * 100)}%`],
      ['matte', 'Matte', 'As dull as paper', (v) => `${Math.round(v * 100)}%`],
      ['rim', 'Rim light', 'A pale edge turned from the eye', (v) => `${Math.round(v * 100)}%`],
      ['colour', 'Colour', 'Grey to full', (v) => `${Math.round(v * 100)}%`],
      ['warmth', 'Warmth', 'Cool shadows, warm lights', (v) => `${Math.round(v * 100)}%`],
      ['contrast', 'Contrast', null, (v) => `${Math.round(v * 100)}%`],
      ['vignette', 'Dark corners', null, (v) => `${Math.round(v * 100)}%`],
      ['paper', 'The page', 'Old paper over the picture', (v) => `${Math.round(v * 100)}%`],
    ],
  },
]

function LightingTab() {
  const l = useLighting()
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const text = lightingText(l)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        () => setShown(true),
      )
    } else setShown(true)
  }
  return (
    <>
      {LIGHT_ROWS.map((section) => (
        <section key={section.title}>
          <h3>{section.title}</h3>
          {section.rows.map(([key, label, hint, show]) => {
            const [min, max, step] = RANGES[key]
            return (
              <Row key={key} label={label} hint={hint ?? undefined}>
                <Slider value={l[key]} min={min} max={max} step={step} show={show(l[key])} onChange={(v) => setLighting({ [key]: v })} />
              </Row>
            )
          })}
        </section>
      ))}
      {shown && <textarea className="lighting-values" readOnly value={lightingText(l)} onFocus={(e) => e.target.select()} />}
      <div className="options-buttons">
        <button onClick={() => setLighting(LIGHTING)}>The game's own</button>
        <button onClick={() => setShown((v) => !v)}>{shown ? 'Hide values' : 'Show values'}</button>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy values'}</button>
        <button className="primary" onClick={() => closeOptions()}>
          Done
        </button>
      </div>
    </>
  )
}

export function OptionsScreen() {
  const open = useOptionsOpen()
  const o = useOptions()
  const [tab, setTab] = useState<'options' | 'lighting'>('options')
  const [full, setFull] = useState(isFullscreen)
  const [, setSize] = useState(0)
  useEffect(() => {
    const changed = () => setFull(isFullscreen())
    const resized = () => setSize((n) => n + 1)
    document.addEventListener('fullscreenchange', changed)
    window.addEventListener('resize', resized)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      window.removeEventListener('resize', resized)
    }
  }, [])
  if (!open) return null
  const set = (patch: Partial<Options>) => setOptions(patch)
  const dpr = window.devicePixelRatio || 1
  const screen = `${Math.round(window.innerWidth * dpr)} × ${Math.round(window.innerHeight * dpr)}`
  const drawn = `${Math.round(window.innerWidth * pixelRatio(o))} × ${Math.round(window.innerHeight * pixelRatio(o))}`
  const tabs = (
    <div className="bookmarks">
      <button className={tab === 'options' ? 'on' : ''} onClick={() => setTab('options')}>
        Options
      </button>
      <button className={tab === 'lighting' ? 'on' : ''} onClick={() => setTab('lighting')}>
        Lighting and look
      </button>
    </div>
  )
  if (tab === 'lighting') {
    return (
      <div className="options-screen docked" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <div className="options-card page">
          <div className="page-body">
            {tabs}
            <LightingTab />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="options-screen" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="options-card page">
        <div className="page-body">
          {tabs}
          <div className="ornament">
            <i />
          </div>
          <div className="options-grid">
            <section>
              <h3>Controls</h3>
              <Row label="Mouse sensitivity">
                <Slider value={o.sensitivity} min={0.0006} max={0.006} step={0.0001} show={`${(o.sensitivity / DEFAULT_SENSITIVITY).toFixed(2)}×`} onChange={(v) => set({ sensitivity: v })} />
              </Row>
              <Row label="Invert mouse" hint="Moving the mouse up looks down">
                <Check value={o.invertY} onChange={(v) => set({ invertY: v })} />
              </Row>
              <Row label="Field of view">
                <Slider value={o.fov} min={60} max={100} step={1} show={`${o.fov}°`} onChange={(v) => set({ fov: v })} />
              </Row>
            </section>

            <section>
              <h3>Display</h3>
              {canFullscreen() && (
                <Row label="Fullscreen" hint="Off: in a window">
                  <Check value={full} onChange={() => toggleFullscreen()} />
                </Row>
              )}
              <Row label="Resolution" hint={`Drawn at ${drawn} of the screen's ${screen}`}>
                <Slider value={Math.round(o.resolution * 100)} min={50} max={100} step={5} show={`${Math.round(o.resolution * 100)}%`} onChange={(v) => set({ resolution: v / 100 })} />
              </Row>
              <Row label="Sharpen">
                <Slider value={Math.round(o.sharpen * 100)} min={0} max={100} step={5} show={`${Math.round(o.sharpen * 100)}%`} onChange={(v) => set({ sharpen: v / 100 })} />
              </Row>
              <Row label="Frame counter" hint="Frames a second, and the resolution drawn">
                <Check value={o.fps} onChange={(v) => set({ fps: v })} />
              </Row>
            </section>

            <section>
              <h3>Graphics</h3>
              <Row label="Preset">
                <select value={o.preset} onChange={(e) => set({ preset: e.target.value as Quality })}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  {o.preset === 'custom' && (
                    <option value="custom" disabled>
                      Custom
                    </option>
                  )}
                </select>
              </Row>
              <Row label="Shadows">
                <select value={o.shadows} onChange={(e) => set({ shadows: e.target.value as Shadows })}>
                  <option value="fine">Fine</option>
                  <option value="soft">Soft</option>
                  <option value="off">Off</option>
                </select>
              </Row>
              <Row label="Antialiasing" hint="FXAA and SMAA are cheap; MSAA is sharper and dearer">
                <select value={o.antialias} onChange={(e) => set({ antialias: e.target.value as Antialias })}>
                  <option value="off">Off</option>
                  <option value="fxaa">FXAA</option>
                  <option value="smaa">SMAA</option>
                  <option value="msaa2">MSAA 2×</option>
                  <option value="msaa4">MSAA 4×</option>
                  <option value="msaa8">MSAA 8×</option>
                </select>
              </Row>
              <Row label="Ambient occlusion" hint="Corners and creases darken">
                <Check value={o.ao} onChange={(v) => set({ ao: v })} />
              </Row>
              <Row label="Bloom" hint="Bright things glow past their edges">
                <Check value={o.bloom} onChange={(v) => set({ bloom: v })} />
              </Row>
              <Row label="Light from effects" hint="Fire and glowing things light what is near">
                <Check value={o.lamps} onChange={(v) => set({ lamps: v })} />
              </Row>
              <Row label="Dust in the light">
                <Check value={o.dust} onChange={(v) => set({ dust: v })} />
              </Row>
            </section>

            <section>
              <h3>Sound</h3>
              <Row label="Volume">
                <Slider value={Math.round(o.volume * 100)} min={0} max={100} step={5} show={`${Math.round(o.volume * 100)}%`} onChange={(v) => set({ volume: v / 100 })} />
              </Row>
              <Row label="Spoken taunts" hint="Always shown as subtitles">
                <Check value={o.voices} onChange={(v) => set({ voices: v })} />
              </Row>
            </section>
          </div>
          <div className="options-buttons">
            <button onClick={() => setOptions(defaults())}>Defaults</button>
            <button className="primary" onClick={() => closeOptions()}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
