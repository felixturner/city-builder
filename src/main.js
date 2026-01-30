import { Demo } from './Demo.js'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'

const loadingEl = document.getElementById('loading')
const canvas = document.getElementById('canvas')

async function init() {
  if (!WebGPU.isAvailable()) {
    loadingEl.textContent = 'WebGPU is not available on your device or browser.'
    return
  }

  const demo = new Demo(canvas)
  await demo.init()

  // Hide loading indicator once first render is done
  loadingEl.style.display = 'none'
}

init()
