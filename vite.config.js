import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

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

export default defineConfig({
  root: '',
  base: './',
  server: {
    // Claude Code worktrees live under .claude/worktrees INSIDE this repo, so
    // without this an edit in a worktree reloads this checkout's server too.
    watch: { ignored: ['**/.claude/**'] },
  },
  plugins: [fullReloadAlways, basicSsl()],
  build: {
    target: 'esnext',
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
