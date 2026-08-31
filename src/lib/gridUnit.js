import { Vector2 } from 'three/webgpu'

/**
 * The movement and grid maths shared by everything that walks the board.
 *
 * Creeps and soldiers are deliberately separate systems - a soldier has no flow
 * field, no wave scheduler, no bombers - but they move over the same lattice in
 * the same way, and each had grown its own copy of these. When only one copy got
 * tuned, friend and foe stopped reading as the same kind of thing.
 */

/** Snap a world coordinate to the centre of its cell. */
export function snapToCell(v, cell, offset = 0) {
  return Math.floor((v - offset) / cell) * cell + cell / 2 + offset
}

/**
 * World-space centre of a tower, written into `out` as (x, z).
 *
 * Towers store their footprint in GRID space, so this is the one place that
 * knows to add the board's offset. Returns a Vector2 whose `y` is world Z.
 */
export function towerWorldCenter(tower, city, out = new Vector2()) {
  const c = tower.box.getCenter(out)
  out.x = c.x + city.gridOffsetX
  out.y = c.y + city.gridOffsetZ
  return out
}

/**
 * Advance one unit's hop between two cells.
 *
 * A hop is a smoothstepped slide from (fromX,fromZ) to (toX,toZ) with a sine arc
 * in Y and a quarter turn of yaw, which is what gives everything on the board its
 * shared bouncing gait. `unit` needs { t, fromX, fromZ, toX, toZ, mesh }.
 *
 * Pass `spin: false` for units that rotate some other way (giants spin slowly on
 * their own). Call only while `unit.t < 1`; settling on arrival is the caller's
 * job, since creeps and soldiers do different things when they land.
 */
export function advanceHop(unit, dt, { duration, baseY, hopHeight, spin = true }) {
  unit.t = Math.min(1, unit.t + dt / duration)
  const e = unit.t * unit.t * (3 - 2 * unit.t) // smoothstep ease
  const m = unit.mesh
  m.position.x = unit.fromX + (unit.toX - unit.fromX) * e
  m.position.z = unit.fromZ + (unit.toZ - unit.fromZ) * e
  m.position.y = baseY + Math.sin(unit.t * Math.PI) * hopHeight
  // The diamond footprint starts at 45deg, so a quarter turn per hop lands it
  // back on a corner every time.
  if (spin) m.rotation.y = Math.PI / 4 + unit.t * (Math.PI / 2)
}
