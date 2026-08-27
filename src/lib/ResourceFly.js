import { Vector3 } from 'three/webgpu'
import gsap from 'gsap'
import { ENERGY_COLOR } from '../palette.js'

/**
 * ResourceFly - little coloured boxes that fly from a world position up to a
 * HUD meter, so income reads as something arriving somewhere rather than a
 * number quietly changing in the corner.
 *
 * The world anchor is projected to the screen ONCE at spawn and the rest is a
 * 2D tween. The generator that produced it may be demolished mid-flight (they
 * expire constantly), and a box chasing a dead tower's position looks wrong -
 * once it's launched it belongs to the screen, not the scene.
 */
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
   * Launch a box from a world position toward a HUD element.
   * @param {Camera} camera - to project the start point
   * @param {HTMLElement} targetEl - element to fly to (its centre)
   * @param {string} color - CSS colour
   * @param {number} [size] - box edge in px
   * @param {number} [delay] - seconds to wait before launching
   */
  spawn(x, y, z, camera, targetEl, color = ENERGY_COLOR, size = 9, delay = 0) {
    if (!camera || !targetEl) return
    this._v.set(x, y, z).project(camera)
    if (this._v.z > 1) return // behind the camera; nothing to see
    const sx = (this._v.x * 0.5 + 0.5) * window.innerWidth
    const sy = (-this._v.y * 0.5 + 0.5) * window.innerHeight

    const r = targetEl.getBoundingClientRect()
    const tx = r.left + r.width / 2
    const ty = r.top + r.height / 2

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
    const tl = gsap.timeline({ delay, onComplete: done })
    tl.to(el, { scale: 1, duration: 0.14, ease: 'back.out(2.5)' })
      // Rise a little first so it reads as leaving the building, then cut across.
      .to(el, { top: `${sy - 26}px`, duration: 0.22, ease: 'power2.out' }, 0)
      .to(el, {
        left: `${tx}px`, top: `${ty}px`,
        duration: 0.55, ease: 'power2.inOut',
      }, 0.22)
      .to(el, { scale: 0.3, opacity: 0, duration: 0.16, ease: 'power2.in' }, '-=0.16')
  }
}
