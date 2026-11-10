/**
 * Dissertation's dev-server side as a Vite plugin: the WebSocket at /ws, where the
 * game on this computer meets the players' browsers. Only the local network may connect
 * ("only local ip's are ok for now"), to the socket and to the page alike. This file is
 * all vite.config.ts loads and it imports nothing of the game: the game (main.ts) comes in
 * through Vite's module runner on the first visit, and again after its code changes, when the
 * old game closes (its sockets with it; the pages reconnect to the new one).
 */

import type { IncomingMessage } from 'node:http'
import os from 'node:os'

import type { Plugin } from 'vite'
import { WebSocketServer } from 'ws'

type MainModule = typeof import('./main')
type Game = Awaited<ReturnType<MainModule['startGame']>>

const WS_PATH = '/ws'
const MAIN = '/src/server/main.ts'

/** Loopback, the private IPv4 ranges, link-local, and IPv6 unique-local and link-local. */
export function isLocal(address: string | undefined): boolean {
  if (!address) return false
  const a = address.startsWith('::ffff:') ? address.slice(7) : address
  if (a === '::1') return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (m) {
    const x = Number(m[1])
    const y = Number(m[2])
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254)
  }
  return /^(fc|fd|fe[89ab])/i.test(a)
}

/** The addresses on this computer's local networks, as links to the game. */
function joinLinks(https: boolean, port: number): string[] {
  const out: string[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Docker's and the VMs' own bridges are no way in for a friend's laptop.
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isLocal(i.address)) out.push(`${https ? 'https' : 'http'}://${i.address}:${port}/`)
    }
  }
  return out
}

export function dissertation(): Plugin {
  return {
    name: 'dissertation',
    apply: (_, env) => env.command === 'serve' && env.mode !== 'test',
    configureServer(server) {
      const log = (message: string) => server.config.logger.info(`[dissertation] ${message}`, { timestamp: true })
      let current: { module: MainModule; game: Game } | null = null
      let loading: Promise<Game> | null = null

      const gameNow = (): Promise<Game> => {
        loading ??= (async () => {
          const module = (await server.ssrLoadModule(MAIN)) as MainModule
          if (current === null || current.module !== module) {
            if (current !== null) {
              log('the game code changed: a new game starts')
              current.game.close()
              current = null
            }
            const port = server.config.server.port ?? 5173
            current = { module, game: await module.startGame(server.config.root, log, joinLinks(Boolean(server.config.server.https), port)) }
          }
          return current.game
        })().finally(() => {
          loading = null
        })
        return loading
      }

      server.middlewares.use((req: IncomingMessage, res, next) => {
        if (!isLocal(req.socket.remoteAddress)) {
          res.statusCode = 403
          res.end('Dissertation is played on the local network only.')
          return
        }
        // The first visit wakes the game, so the first arena is being built while the page loads.
        gameNow().catch((err: Error) => log(`the game did not load: ${err.message}`))
        next()
      })

      const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
      server.httpServer?.on('upgrade', (req: IncomingMessage, socket, head) => {
        if (!(req.url ?? '').startsWith(WS_PATH)) return
        if (!isLocal(req.socket.remoteAddress)) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // The page says hello as soon as the socket opens, which may be before the game has
          // loaded: what comes meanwhile waits in line.
          const early: string[] = []
          let gone = false
          const onEarly = (data: unknown) => early.push(String(data))
          ws.on('message', onEarly)
          ws.once('close', () => (gone = true))
          gameNow().then(
            (game) => {
              if (gone) return
              const h = game.connect({
                send: (text) => {
                  if (ws.readyState === ws.OPEN) ws.send(text)
                },
                close: () => ws.close(),
              })
              ws.off('message', onEarly)
              ws.on('message', (data) => h.message(data.toString()))
              ws.on('close', () => h.close())
              ws.on('error', () => h.close())
              for (const text of early.splice(0)) h.message(text)
            },
            (err: Error) => {
              log(`the game did not load: ${err.message}`)
              ws.close(1011, 'the game did not load')
            },
          )
        })
      })

      const stop = () => {
        current?.game.close()
        current = null
        process.off('exit', stop)
      }
      process.once('exit', stop)
      server.httpServer?.once('close', stop)
    },
  }
}
