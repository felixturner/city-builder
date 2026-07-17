import { Demo } from './Demo.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { Sounds } from './lib/Sounds.js'

const loadingEl = document.getElementById('loading')
const loaderGif = document.getElementById('loader-gif')
const tuteImg = document.getElementById('tute-img')
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

  // WebGPU ready - hide loader gif, show first tutorial image + Next button
  loaderGif.style.display = 'none'
  tuteImg.style.display = 'block'
  startBtn.style.display = 'block'
  new Image().src = 'assets/tute2.png' // preload so the Next swap is instant
}

function start() {
  // Play intro sound (also unlocks AudioContext on user gesture)
  Sounds.play('intro')

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

// First click advances tute1 -> tute2 (Next); the second click starts the game.
let tuteStep = 1
function nextOrStart() {
  if (tuteStep === 1) {
    tuteStep = 2
    tuteImg.src = 'assets/tute2.png'
    startBtn.textContent = 'Start'
  } else {
    start()
  }
}
startBtn.addEventListener('click', nextOrStart)
init()
