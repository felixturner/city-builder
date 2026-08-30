import { Mesh, BoxGeometry, MeshStandardNodeMaterial, Vector3, Color } from 'three/webgpu'
import gsap from 'gsap'
import { Sounds } from './lib/Sounds.js'
import { ACCENT_COLORS } from './palette.js'

/**
 * LootBoxes - six crates scattered over the board that pay out an upgrade when
 * you WALL THEM IN.
 *
 * This replaces upgrades-on-a-timer. A card every N waves arrived whether or not
 * you'd done anything; a crate is a thing you have to notice, reach and enclose,
 * so the reward is spent on the same walls you were already building.
 *
 * Enclosure is read from city.enclosedCells, the mask the flood-fill already
 * computes each time the city changes - a crate needs no collision of its own,
 * it just asks whether its cell ended up sealed.
 */

const COUNT = 6 // one per angular slice, so they can't all cluster on one side
const SIZE = 1.5 // world units across
const MIN_R = 0.30 // placement band, as a fraction of the grid half-extent...
const MAX_R = 0.90 // ...keeping crates off the king and inside the buildable area
const BOB_HEIGHT = 0.35
const BOB_SPEED = 1.6 // radians/sec
const SPIN_SPEED = 0.9 // radians/sec about Y (upright spin, like a pickup)
const HOVER_Y = 1.6 // resting height above the ground
const SHAKE_TIME = 0.75 // seconds of rattling before it bursts
const CONFETTI_PER_COLOUR = 14

export class LootBoxes {
  constructor(scene, city, demo) {
    this.scene = scene
    this.city = city
    this.demo = demo
    this.boxes = []
    this.geo = new BoxGeometry(SIZE, SIZE, SIZE)
    this._v = new Vector3()
    this.elapsed = 0
  }

  /** Scatter the crates: one per 360/COUNT slice, at a random angle and radius
   *  inside that slice, nudged to the nearest free cell. */
  place() {
    const city = this.city
    const half = city.actualGridWidth / 2
    for (let i = 0; i < COUNT; i++) {
      const a0 = (i / COUNT) * Math.PI * 2
      const ang = a0 + Math.random() * (Math.PI * 2 / COUNT)
      const r = (MIN_R + Math.random() * (MAX_R - MIN_R)) * half
      const spot = this.freeCellNear(Math.cos(ang) * r, Math.sin(ang) * r)
      if (spot) this.spawn(spot.x, spot.z)
    }
  }

  /** Snap to the centre of the nearest unoccupied cell, spiralling outward if
   *  the first choice is taken. Returns null if nothing free is nearby. */
  freeCellNear(x, z) {
    const city = this.city
    const cu = city.cellUnit
    const start = city.worldToCell(x, z)
    if (!start) return null
    for (let ring = 0; ring < 6; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue
          const gx = start.gx + dx, gy = start.gy + dy
          if (gx < 0 || gy < 0 || gx >= city.gridCellsX || gy >= city.gridCellsY) continue
          if (city.occupied[gy] && city.occupied[gy][gx]) continue
          return {
            gx, gy,
            x: gx * cu + cu / 2 + city.gridOffsetX,
            z: gy * cu + cu / 2 + city.gridOffsetZ,
          }
        }
      }
    }
    return null
  }

  spawn(x, z) {
    const colorIndex = Math.floor(Math.random() * ACCENT_COLORS.length)
    const accent = ACCENT_COLORS[colorIndex]
    const mat = new MeshStandardNodeMaterial({
      color: new Color(accent),
      emissive: new Color(accent).multiplyScalar(0.35),
      roughness: 0.35,
      metalness: 0.1,
    })
    const mesh = new Mesh(this.geo, mat)
    mesh.position.set(x, HOVER_Y, z)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.boxes.push({
      mesh, mat, colorIndex, x, z,
      phase: Math.random() * Math.PI * 2, // so they don't bob in lockstep
      opening: false,
    })
  }

  /** True if a crate is sitting on this cell. Placement checks this: a wall
   *  built ON a crate makes its cell part of the wall mask, so it could never
   *  be enclosed and the crate would be dead for the rest of the run. */
  occupiesCell(gx, gy) {
    for (const b of this.boxes) {
      const c = this.city.worldToCell(b.x, b.z)
      if (c && c.gx === gx && c.gy === gy) return true
    }
    return false
  }

  /** True if the crate's cell has ended up inside a sealed region. */
  isEnclosed(b) {
    const cell = this.city.worldToCell(b.x, b.z)
    if (!cell || !this.city.enclosedCells) return false
    return !!this.city.enclosedCells[cell.gy * this.city.gridCellsX + cell.gx]
  }

  update(dt) {
    this.elapsed += dt
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i]
      if (b.opening) continue // gsap owns its transform until it bursts

      b.mesh.position.y = HOVER_Y + Math.sin(this.elapsed * BOB_SPEED + b.phase) * BOB_HEIGHT
      b.mesh.rotation.y += SPIN_SPEED * dt

      if (this.isEnclosed(b)) this.open(b, i)
    }
  }

  /** Sealed: rattle, burst into confetti, then hand the payout to the caller. */
  open(b, i) {
    b.opening = true
    this.boxes.splice(i, 1) // out of the update loop; gsap drives it from here
    Sounds.play('alert3', 1.2, 0.05, 0.4)

    const m = b.mesh
    const tl = gsap.timeline()
    // Rattle: a fast positional jitter that grows as it builds.
    tl.to(m.position, {
      duration: SHAKE_TIME,
      ease: 'none',
      onUpdate: () => {
        const p = tl.progress()
        const amp = 0.06 + p * 0.22
        m.position.x = b.x + (Math.random() - 0.5) * amp * 2
        m.position.z = b.z + (Math.random() - 0.5) * amp * 2
        m.rotation.y += 0.5 * p
      },
    })
    tl.to(m.scale, { x: 1.35, y: 1.35, z: 1.35, duration: 0.12, ease: 'power2.out' })
    tl.call(() => this.burst(b))
  }

  burst(b) {
    const m = b.mesh
    this.scene.remove(m)
    m.material.dispose()

    // Confetti in all three accents, not just the crate's own colour.
    const debris = this.city.debris
    if (debris) {
      for (const c of ACCENT_COLORS) {
        debris.spawn(b.x, HOVER_Y, b.z, 1.2, c, CONFETTI_PER_COLOUR)
      }
    }
    Sounds.play('level-complete', 1.15, 0.02, 0.5)

    // Hand the screen position over so the cards can fly out of the crate.
    const screen = this.toScreen(b.x, HOVER_Y, b.z)
    this.onOpened?.(screen)
  }

  /** Project a world point to screen pixels, for the card fly-out origin. */
  toScreen(x, y, z) {
    const cam = this.demo.camera
    if (!cam) return null
    this._v.set(x, y, z).project(cam)
    if (this._v.z > 1) return null // behind the camera
    return {
      x: (this._v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this._v.y * 0.5 + 0.5) * window.innerHeight,
    }
  }
}
