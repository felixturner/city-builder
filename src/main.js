import { Demo } from './Demo.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Sounds } from './lib/Sounds.js'
import { Tutorial } from './Tutorial.js'
import { ENERGY_COLOR } from './palette.js'
import { seedSim, currentSeed } from './lib/rng.js'

const loadingEl = document.getElementById('loading')
const loaderGif = document.getElementById('loader-gif')
const menuEl = document.getElementById('menu')
const canvas = document.getElementById('canvas')

const tutorial = new Tutorial()

let demo = null
const params = new URLSearchParams(location.search)
// Sim steps per frame when replaying, unless ?speed says otherwise. Real time is
// what you already sat through once.
const REPLAY_SPEED = 4
// The recording ?replay is playing back, if any - fetched before the game is
// built, applied once it is running.
let replayRun = null

// Hosts the game is allowed to run on. A re-hosted copy of the bundle fails
// this and stops at a plain message instead of the game (the _headers CSP
// already blocks iframe embeds; this catches full re-hosts).
const ALLOWED_HOSTS = /(^|\.)pages\.dev$|^localhost$|^127\.0\.0\.1$/

async function init() {
  if (!ALLOWED_HOSTS.test(location.hostname)) {
    loadingEl.innerHTML =
      '<p style="color:#fff">Play City Builder at <a style="color:#fff" href="https://city-builder-apz.pages.dev">city-builder-apz.pages.dev</a></p>'
    return
  }
  if (!WebGPU.isAvailable()) {
    loadingEl.innerHTML = '<p style="color:#fff">WebGPU is not available on your device or browser.</p>'
    return
  }

  // Seed before the world is built: City.init places the rocks and fills the
  // tile bag, both off the sim stream. A replay has to install its recorded seed
  // ahead of that or it gets a different board to the run it is replaying.
  replayRun = await loadRecording()
  seedSim(replayRun ? replayRun.seed : undefined)

  demo = new Demo(canvas)
  await demo.init()
  demo.tutorial = tutorial // the Esc pause menu re-opens it

  // WebGPU ready - swap the loader gif for the main menu.
  loaderGif.style.display = 'none'
  document.getElementById('menu-title').style.color = ENERGY_COLOR

  // ?play (set by the pause menu's New game) skips the menu straight into the
  // run. Stripped from the URL so a manual refresh lands on the menu again.
  // No click means no AudioContext unlock here - Howler's autoUnlock starts
  // the beds on the first tap instead.
  const startParams = new URLSearchParams(location.search)
  if (startParams.has('play')) {
    startParams.delete('play')
    const qs = startParams.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
    Sounds.loadDeferred()
    start()
    return
  }

  menuEl.style.display = 'flex'
  // The menu is up; pull the rest of the audio down while the player reads it.
  Sounds.loadDeferred()
}

/**
 * Fetch the recording ?replay is asking for, or null.
 *
 * Bare `?replay` takes the newest recorded run. `?replay=<id>` pins one - any
 * part of its filename will do, so `?replay=21-41` is enough - which is what a
 * balance pass needs: hold the run still and change a constant under it, rather
 * than have the next game played quietly become the baseline.
 *
 * Runs before the game is built, because the seed it carries has to be in place
 * before anything draws from the sim stream (see init).
 */
async function loadRecording() {
  if (!params.has('replay')) return null
  try {
    const want = params.get('replay') // '' for a bare ?replay
    const run = await (await fetch(`/__run${want ? `?id=${encodeURIComponent(want)}` : ''}`)).json()
    if (run?.error) throw new Error(run.error)
    if (!run || !run.events?.length) throw new Error('empty')
    console.log(`[run] loaded ${run.id || '?'} - ${run.events.length} actions,`
      + ` seed ${run.seed}, commit ${run.commit || '?'}${run.dirty ? ' (dirty)' : ''}`)
    return run
  } catch (err) {
    console.warn('[run] no recording to replay:', err.message)
    return null
  }
}

function start() {
  // The seed the world was actually built with (set in init), so the recording
  // reproduces this board and not just this sequence of clicks.
  if (demo.run) demo.run.seed = currentSeed()

  // Background beds loop for the whole session. They can only be started from
  // inside a user gesture, so this has to happen here and nowhere earlier - and
  // starting them is also what unlocks the AudioContext, which is why the two
  // intro stings can wait for the camera move (see City.startIntroAnimation).
  Sounds.startBeds()
  Sounds.setBedMode('build', 3.0)

  // Hide loading + tutorial overlays
  loadingEl.style.display = 'none'
  tutorial.hide()

  // Fade up, camera fall and the opening stings all start here, together.
  demo.fadeIn(500)

  // Enable gameplay updates (frozen until now so nothing runs on the start screen)
  demo.started = true

  // Start intro build animation
  demo.city.startIntroAnimation(demo.camera, demo.controls, 1.0)

  // Release the creeps (grace period counts from here)
  demo.creeps.start()
  demo.econ?.begin(1) // open the first round's economy record
  // A recording replaces player input for the whole run. Installed after the
  // game is otherwise ready, so the first tick already has a world to act on.
  if (replayRun && !demo.run) {
    console.warn('[run] ?replay needs ?dev - nothing was replayed')
  }
  if (replayRun && demo.run) {
    demo.run.load(replayRun)
    // ?speed=N runs N sim steps a frame. Past about 4 the sound is a mess -
    // every hit and footstep of N seconds arrives in one - so it goes quiet.
    const speed = Math.max(1, Math.min(60, Number(params.get('speed')) || REPLAY_SPEED))
    demo.replaySpeed = speed
    if (speed > 4) Sounds.setMusicEnabled(false)
    console.log(`[run] replaying ${replayRun.events.length} actions over`
      + ` ${replayRun.ticks} ticks at ${speed}x, seed ${replayRun.seed}`)
  }
}

// Main menu. Both paths run inside a click, so the AudioContext unlock in
// start() keeps working; the tutorial's final Play click starts the game.
document.getElementById('menu-new').addEventListener('click', start)
document.getElementById('menu-tutorial').addEventListener('click', async () => {
  // Hide the menu only once the slideshow is actually up - dropping it first
  // exposed the canvas behind for a frame while the md/image fetched. Done on
  // the last page brings the start menu back rather than starting the game.
  await tutorial.show(() => { loadingEl.style.display = 'flex' })
  loadingEl.style.display = 'none'
})
init()
