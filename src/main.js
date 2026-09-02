import { Demo } from './Demo.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Sounds } from './lib/Sounds.js'
import { Tutorial } from './Tutorial.js'
import { ENERGY_COLOR } from './palette.js'

const loadingEl = document.getElementById('loading')
const loaderGif = document.getElementById('loader-gif')
const menuEl = document.getElementById('menu')
const canvas = document.getElementById('canvas')

const tutorial = new Tutorial()

let demo = null

async function init() {
  if (!WebGPU.isAvailable()) {
    loadingEl.innerHTML = '<p style="color:#fff">WebGPU is not available on your device or browser.</p>'
    return
  }

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
  const params = new URLSearchParams(location.search)
  if (params.has('play')) {
    params.delete('play')
    const qs = params.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
    Sounds.loadDeferred()
    start()
    return
  }

  menuEl.style.display = 'flex'
  // The menu is up; pull the rest of the audio down while the player reads it.
  Sounds.loadDeferred()
}

function start() {
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
