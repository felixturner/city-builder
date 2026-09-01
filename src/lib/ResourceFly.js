import { Vector3 } from 'three/webgpu'
import gsap from 'gsap'
import { ENERGY_COLOR } from '../palette.js'

/**
 * ResourceFly - little coloured boxes that pop out of a generator, rise, and
 * burst, so income reads as something being produced rather than a number
 * quietly changing in the corner.
 *
 * They used to fly all the way to the HUD meter. At a developed economy that is
 * several boxes a second all converging on the same corner of the screen, which
 * drew the eye away from the board and turned the top-left into a stream of
 * traffic. Popping in place says the same thing where you are already looking.
 *
 * The world anchor is projected to the screen ONCE at spawn and the rest is a
 * 2D tween. The generator that produced it may be demolished mid-animation
 * (they expire constantly), and a box chasing a dead tower's position looks
 * wrong - once it's launched it belongs to the screen, not the scene.
 */
// Screen pixels the box rises before it bursts.
const RISE = 51

export class ResourceFly {
  constructor() {
    this._v = new Vector3()
    const c = document.createElement('div')
    Object.assign(c.style, {
      position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', overflow: 'hidden', zIndex: '490',
    })
    document.body.appendChild(c)
    this.container = c
  }

  /**
   * Pop a box out of a world position.
   * @param {Camera} camera - to project the start point
   * @param {string} color - CSS colour
   * @param {number} [size] - box edge in px
   * @param {number} [delay] - seconds to wait before launching
   */
  spawn(x, y, z, camera, color = ENERGY_COLOR, size = 13.5, delay = 0) {
    if (!camera) return
    this._v.set(x, y, z).project(camera)
    if (this._v.z > 1) return // behind the camera; nothing to see
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight

    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'absolute',
      left: `${sx}px`, top: `${sy}px`,
      width: `${size}px`, height: `${size}px`,
      background: color,
      boxShadow: `0 0 8px ${color}`,
      borderRadius: '2px',
      transform: 'translate(-50%, -50%) scale(0)',
      willChange: 'left, top, transform, opacity',
    })
    this.container.appendChild(el)

    const done = () => { if (el.parentNode) this.container.removeChild(el) }
    // Pop up, then burst. Three beats: it appears, it leaves the building, it
    // goes off. The rise is straight up in SCREEN space, so it reads the same
    // whichever way the board is turned.
    const tl = gsap.timeline({ delay, onComplete: done })
    tl.to(el, { scale: 1, duration: 0.14, ease: 'back.out(2.5)' })
      .to(el, { top: `${sy - RISE}px`, duration: 0.3, ease: 'power2.out' }, 0)
      // The burst overshoots well past full size as it goes transparent, so the
      // eye reads a flash rather than a box shrinking away.
      .to(el, { scale: 2.6, opacity: 0, duration: 0.22, ease: 'power2.out' }, 0.3)
  }
}
