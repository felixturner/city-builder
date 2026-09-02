import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

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
/**
 * Dev-only store for recorded runs (see systems/RunRecorder.js).
 *
 * ONE file per run - `logs/run-<id>.json` - holding the seed, every player
 * action, and the per-round economy figures. They used to be two files written
 * by two endpoints, which meant a replay appended a second set of rounds to the
 * economy log while writing no run of its own, and the two disagreed about what
 * had happened.
 *
 * The client sends the same `id` every time, so a run rewrites its own file as
 * it goes: the numbers survive a crash, which is the failure the incremental
 * writing was there for, without leaving a file per round.
 *
 * The commit is stamped in HERE rather than baked into the bundle - the browser
 * has no idea what it was built from, and a run's numbers only mean anything
 * against the exact code that produced them. `dirty` matters as much as the sha:
 * most runs during a balance pass are made against uncommitted edits.
 */
const runStore = {
  name: 'run-store',
  configureServer(server) {
    const dir = fileURLToPath(new URL('./logs/', import.meta.url))
    const git = (cmd) => {
      try { return execSync(cmd, { encoding: 'utf8' }).trim() } catch { return '' }
    }
    const newest = () => readdirSync(dir)
      .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
      .sort()
      .pop()
    server.middlewares.use('/__run', (req, res) => {
      if (req.method === 'GET') {
        try {
          const file = newest()
          if (!file) throw new Error('none')
          res.setHeader('Content-Type', 'application/json')
          return res.end(readFileSync(join(dir, file), 'utf8'))
        } catch {
          res.statusCode = 404
          return res.end('{}')
        }
      }
      if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          mkdirSync(dir, { recursive: true })
          const run = JSON.parse(body)
          const stamped = {
            commit: git('git rev-parse --short HEAD'),
            dirty: git('git status --porcelain') !== '',
            savedAt: new Date().toISOString(),
            ...run,
          }
          const id = String(run.id || 'unknown').replace(/[^\w.-]/g, '')
          writeFileSync(join(dir, `run-${id}.json`), JSON.stringify(stamped, null, 1))
        } catch { /* dev only */ }
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
  plugins: [fullReloadAlways, runStore, basicSsl()],
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
