import { Mesh, BoxGeometry, MeshStandardNodeMaterial, Color } from 'three/webgpu'
import gsap from 'gsap'
import { Sounds } from './lib/Sounds.js'
import { ACCENT_COLORS } from './palette.js'
import { ENERGY_COLOR } from './Mana.js'
import { simRand } from './lib/rng.js'
import { glow, NO_AO_MRT } from './fx.js'
import { ExtraGeometry } from './lib/ExtraGeometry.js'

/**
 * LootBoxes - crates scattered over the board that pay out energy when
 * you WALL THEM IN.
 *
 * A crate is a thing you have to notice, reach and enclose, so the reward is
 * spent on the same walls you were already building. It used to hand out upgrade
 * cards; those went back to boss rounds, and the crate pays resources instead.
 *
 * Enclosure is read from city.enclosure.enclosedCells, the mask the flood-fill already
 * computes each time the city changes - a crate needs no collision of its own,
 * it just asks whether its cell ended up sealed.
 */

const COUNT = 8 // one per angular slice, so they can't all cluster on one side
const SIZE = 0.735 // world units across, for the fallback cube
// Corner-up tilt for the FALLBACK cube only: 45deg about Z stands it on an edge,
// then atan(1/sqrt2) about X tips that edge onto a point. The star model needs
// none of this - it sits flat on the floor and spins, which never goes edge-on
// to a camera looking down at the board.
const CORNER_TILT_Z = Math.PI / 4
const CORNER_TILT_X = -Math.atan(1 / Math.SQRT2) // ~-35.26deg
const MIN_R = 0.30 // placement band, as a fraction of the grid half-extent...
const MAX_R = 0.90 // ...keeping crates off the king and inside the buildable area
const BOB_HEIGHT = 0.35 // fallback cube only - the star stays on the floor
const BOB_SPEED = 1.6 // radians/sec
const SPIN_SPEED = -0.9 // radians/sec about Y; negative = clockwise seen from above
const HOVER_Y = 1.6 // fallback cube resting height above the ground
const REST_Y = 0.05 // star resting height - a hair up so it can't z-fight the floor
// Accent index every star wears: 1 is the yellow, the same one the king takes.
const STAR_COLOR = 1
const SHAKE_TIME = 0.75 // seconds of rattling before it bursts
const CONFETTI_PER_COLOUR = 14
// Base payout for walling in a crate, multiplied by the current level.
const CRATE_REWARD = 20

export class LootBoxes {
  constructor(scene, city, demo) {
    this.scene = scene
    this.city = city
    this.demo = demo
    this.boxes = []
    // The star from game-extra.glb, or the old cube if it didn't load. Its
    // authored grey is ignored - the crate takes a city accent, as before.
    this.geo = ExtraGeometry.star || new BoxGeometry(SIZE, SIZE, SIZE)
    this.usingStar = !!ExtraGeometry.star
    this.elapsed = 0
  }

  /**
   * Scatter the crates: one per 360/COUNT slice, at a random angle and radius
   * inside that slice, nudged to the nearest free cell.
   *
   * Spread across the LARGEST play area the board will ever reach, like the
   * rocks - so a ring that opens after a boss round arrives with crates already
   * on it, rather than every crate being crowded into the opening 5x5. The ones
   * out of bounds are switched off until their ring opens (see refresh).
   */
  place() {
    const city = this.city
    const half = city.maxPlayHalf
    for (let i = 0; i < COUNT; i++) {
      const a0 = (i / COUNT) * Math.PI * 2
      const ang = a0 + simRand() * (Math.PI * 2 / COUNT)
      const r = (MIN_R + simRand() * (MAX_R - MIN_R)) * half
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
    // Every star is the same yellow. They used to draw one of the three accents
    // at random, which made a colour that means nothing - the accents are the
    // vocabulary the tiles use, and a crate borrowing one read as a tile type.
    const colorIndex = STAR_COLOR
    const accent = ACCENT_COLORS[colorIndex]
    // Emissive is back to a sane level now that glow is opt-in by layer: the
    // crate no longer has to out-shine the whole board to be picked out by a
    // luminance threshold, it just has to be on the layer.
    const mat = new MeshStandardNodeMaterial({
      color: new Color(accent),
      emissive: new Color(accent).multiplyScalar(0.5),
      roughness: 0.35,
      metalness: 0.1,
    })
    // Every material that reaches the glow pass has to declare the same two MRT
    // outputs as the target's attachments, so the crate carries the flat-normal
    // node too. Side benefit: a floating gem gets no ambient occlusion, which is
    // what you'd want anyway.
    mat.mrtNode = NO_AO_MRT()
    const mesh = glow(new Mesh(this.geo, mat))
    mesh.rotation.order = 'YXZ' // spin about world up, not the tilted axis
    const spin = Math.random() * Math.PI * 2 // so they don't turn in lockstep
    if (this.usingStar) mesh.rotation.set(0, spin, 0)
    else mesh.rotation.set(CORNER_TILT_X, spin, CORNER_TILT_Z)
    mesh.position.set(x, this.usingStar ? REST_Y : HOVER_Y, z)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.boxes.push({
      mesh, mat, colorIndex, x, z,
      phase: Math.random() * Math.PI * 2, // so they don't bob in lockstep
      active: true, // set properly by refresh()
      opening: false,
    })
  }

  /**
   * Switch crates on or off by whether their ring has opened yet.
   *
   * An out-of-bounds crate is hidden AND inert: it doesn't bob, doesn't spin,
   * and can't be claimed. Without the inert half it could be sealed by walls it
   * is nowhere near - the enclosure fill covers the whole grid, not just the
   * part you can build on - and pay out from ground you have never seen.
   */
  refresh() {
    for (const b of this.boxes) {
      const cell = this.city.worldToCell(b.x, b.z)
      b.active = !!cell && this.city.inPlayArea(cell.gx, cell.gy)
      b.mesh.visible = b.active
    }
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
    const mask = this.city.enclosure.enclosedCells
    if (!cell || !mask) return false
    return !!mask[cell.gy * this.city.gridCellsX + cell.gx]
  }

  update(dt) {
    this.elapsed += dt
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i]
      if (b.opening) continue // gsap owns its transform until it bursts

      if (!b.active) continue // its ring hasn't opened yet

      // The star sits flat on the floor and only spins; the fallback cube
      // hovers and bobs like the old pickup.
      if (!this.usingStar) {
        b.mesh.position.y = HOVER_Y + Math.sin(this.elapsed * BOB_SPEED + b.phase) * BOB_HEIGHT
      }
      b.mesh.rotation.y += SPIN_SPEED * dt

      if (this.isEnclosed(b)) this.open(b, i)
    }
  }

  /** Sealed: rattle, burst into confetti, then hand the payout to the caller. */
  open(b, i) {
    b.opening = true
    this.boxes.splice(i, 1) // out of the update loop; gsap drives it from here
    Sounds.play('energy-down-2', 1.2, 0.05, 0.4) // was alert3

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
        m.rotation.y -= 0.5 * p // same clockwise sense as the idle spin
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
        debris.spawn(b.x, m.position.y + 0.5, b.z, 1.2, c, CONFETTI_PER_COLOUR)
      }
    }
    Sounds.play('pick-up', 1.0, 0.04, 0.7)
    this.payOut(b)
  }

  /**
   * A crate pays energy. It used to flip a coin between energy and ammo; ammo is
   * gone, so there is only one currency left to pay in.
   *
   * Upgrade cards moved back onto boss rounds, so a crate is a resource pickup
   * now - which suits what it costs: walling one in is a deliberate detour off
   * whatever you were building, and the payout lands in the same currency you
   * spent getting there.
   *
   * Scaled by level because a flat 20 stops being worth the detour once your
   * income is in the hundreds - the crate has to keep pace with the economy or
   * it quietly becomes scenery.
   */
  payOut(b) {
    const mana = this.city.mana
    if (!mana) return
    const level = (this.demo.creeps?.waveNumber ?? 0) + 1
    const amount = CRATE_REWARD * level
    mana.add(amount)

    this.city.floatingText?.spawn(
      b.x, b.mesh.position.y + 1.2, b.z, `+${amount} energy`, ENERGY_COLOR, 0, null
    )
  }
}
