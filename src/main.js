import { Demo } from './Demo.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Sounds } from './lib/Sounds.js'

const loadingEl = document.getElementById('loading')
const loaderGif = document.getElementById('loader-gif')
const startBtn = document.getElementById('start-btn')
const canvas = document.getElementById('canvas')

let demo = null

async function init() {
  if (!WebGPU.isAvailable()) {
    loadingEl.innerHTML = '<p style="color:#fff">WebGPU is not available on your device or browser.</p>'
    return
  }

  demo = new Demo(canvas)
  await demo.init()

  // WebGPU ready - hide loader gif, show Start button
  loaderGif.style.display = 'none'
  startBtn.style.display = 'block'
  startBtn.textContent = 'Start'

  // The button is up; pull the rest of the audio down while the player reads it.
  Sounds.loadDeferred()
}

function start() {
  // Play intro sound (also unlocks AudioContext on user gesture)
  Sounds.play('intro')
  // Background beds loop for the whole session. They can only be started from
  // inside a user gesture, so this has to happen here and nowhere earlier.
  Sounds.startBeds()
  Sounds.setBedMode('build', 3.0)
  // Reveal sting over the opening build period, under the intro animation.
  Sounds.play('reveal', 1.0, 0, 0.5)

  // Hide loading overlay
  loadingEl.style.display = 'none'

  // Fade in scene
  demo.fadeIn(1000)

  // Enable gameplay updates (frozen until now so nothing runs on the start screen)
  demo.started = true

  // Start intro build animation
  demo.city.startIntroAnimation(demo.camera, demo.controls, 2.5)

  // Release the creeps (grace period counts from here)
  demo.creeps.start()
}

startBtn.addEventListener('click', start)
init()
