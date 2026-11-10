import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// '.js' names plugin.ts (TypeScript allows it), so loading the config warns of no extensionless import.
import { dissertation } from './src/server/plugin.js'

/**
 * One page (index.html) and the game behind it: the plugin runs the game inside this dev server
 * and meets the players' browsers on a WebSocket, for the local network only. There is no build:
 * the game plays where the dev server runs.
 */
export default defineConfig({
  // No SPA fallback: a wrong address is a 404, not a page whose scripts do not load.
  appType: 'mpa',
  plugins: [react(), dissertation()],
  server: {
    // Every address of this computer, so friends on the same network can join. Plain http: no
    // certificate covers a LAN address. A taken port fails the start: the links the game shows
    // its players carry this port.
    host: '0.0.0.0',
    port: 3003,
    strictPort: true,
    // The game saves what it makes in library/: saving must not reload the page.
    watch: { ignored: ['**/library/**'] },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
