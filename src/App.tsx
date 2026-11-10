/**
 * Dissertation's page: one connection to the game on the host's computer, then the dressing room
 * between rounds and the round itself while one is on (a player who came in the middle of one
 * watches it), and over either the options screen, which O opens at any time.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

import { Dressing } from './Dressing'
import { Net } from './net'
import { closeOptions, openOptions, useOptionsOpen } from './options'
import { OptionsScreen } from './OptionsScreen'
import { Round } from './Round'
import { wakeAudio } from './sounds'

export function App() {
  const [net] = useState(() => new Net())
  const optionsOpen = useOptionsOpen()
  useSyncExternalStore(
    (l) => net.subscribe(l),
    () => net.version,
  )
  useEffect(() => {
    document.title = 'Dissertation'
    // Browsers let a page make sound only after a click or a key: the first of either wakes it.
    const wake = () => wakeAudio()
    document.addEventListener('pointerdown', wake, true)
    document.addEventListener('keydown', wake, true)
    return () => {
      document.removeEventListener('pointerdown', wake, true)
      document.removeEventListener('keydown', wake, true)
    }
  }, [])
  // O opens and closes the options anywhere but in a text box; Esc closes them.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
      if (e.code === 'KeyO' && !e.repeat) {
        if (optionsOpen) closeOptions()
        else openOptions()
      } else if (e.code === 'Escape' && optionsOpen) closeOptions()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [optionsOpen])
  let page: React.ReactNode
  const message = (text: string) => (
    <div className="message">
      <div className="page">{text}</div>
    </div>
  )
  if (net.refused) page = message(net.refused)
  else if (!net.connected || !net.lobby) page = message('Finding the committee…')
  else if (net.lobby.phase === 'dressing' || !net.arena) page = <Dressing net={net} lobby={net.lobby} />
  else page = <Round net={net} lobby={net.lobby} />
  return (
    <>
      {page}
      <OptionsScreen />
    </>
  )
}
