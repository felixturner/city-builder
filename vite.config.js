import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'

// Files that are actually part of the running game. Anything else - docs, notes,
// blend files, the README - can be saved without throwing away the run in the
// browser, which a blanket full-reload was doing.
const RELOADS = /\.(js|mjs|css|html|glb|gltf|mp3|wav|hdr|png|jpg|svg)$/i

const fullReloadAlways = {
  name: 'full-reload-always',
  handleHotUpdate({ server, file }) {
    if (!RELOADS.test(file)) return []
    server.ws.send({ type: 'full-reload' })
    return []
  },
}

/**
 * Dev-only sink for the per-round economy log (see systems/EconLog.js).
 *
 * The game POSTs one JSON object per round and this appends it to econ.log as a
 * line. Written as it happens rather than collected in the page, because the
 * runs worth reading are the long ones and a long run is exactly what tends to
 * end in a crash - taking the numbers with it.
 */
const econLog = {
  name: 'econ-log',
  configureServer(server) {
    const file = fileURLToPath(new URL('./econ.log', import.meta.url))
    server.middlewares.use('/__econ', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try { appendFileSync(file, body.trim() + '\n') } catch { /* dev only */ }
        res.statusCode = 204
        res.end()
      })
    })
  },
}

export default defineConfig({
  root: '',
  base: './',
  server: {
    // Claude Code worktrees live under .claude/worktrees INSIDE this repo, so
    // without this an edit in a worktree reloads this checkout's server too.
    // Anchored to THIS config's own .claude folder - a bare '**/.claude/**'
    // also matched every file of a server running inside a worktree (its path
    // contains /.claude/), which silently killed that server's reloading.
    watch: { ignored: [fileURLToPath(new URL('./.claude/**', import.meta.url))] },
  },
  plugins: [fullReloadAlways, econLog, basicSsl()],
  build: {
    target: 'esnext',
    sourcemap: false, // never ship readable source with the bundle
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
})
