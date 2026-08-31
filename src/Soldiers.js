import { Mesh, BoxGeometry, MeshStandardNodeMaterial, Vector2, Color } from 'three/webgpu'
import { Sounds } from './lib/Sounds.js'
import { isBarracks, BARRACKS_COLOR } from './blockTypes.js'
import { Creeps } from './Creeps.js'
import { Buffs } from './buffs.js'
import { Tower } from './Tower.js'
import { advanceHop, snapToCell, towerWorldCenter } from './lib/gridUnit.js'

/**
 * Soldiers - the little friendly cubes a barracks puts out.
 *
 * They hop cell to cell exactly like creeps do (snapped to cell centres, one
 * step at a time, smoothstepped with a hop), loiter near the barracks that
 * raised them, and close on any creep that comes within earshot to trade blows.
 *
 * Deliberately NOT built on Creeps. Creeps carry a flow-field pathfinder,
 * shooters, lasers, bombers and the wave scheduler, none of which a soldier
 * wants; a shared base class would have meant refactoring all of that around a
 * unit that just walks toward a point and stops at walls. What the two share is
 * the STEP MODEL, which is a dozen lines, plus the city grid and Creeps.hit().
 */

// Cube geometry is 2 units, so this scale is also the body's half-extent.
// 0.467 puts a soldier at 0.47 of a cell across - 30% down from the 2/3 it was.
const SIZE = 0.467
const HOME_RADIUS = 5 // cells: how far a soldier drifts from its barracks
const ENGAGE_RADIUS = 10 // cells: how far it will notice and chase a creep
const LEASH_RADIUS = 14 // cells: it breaks off a chase past this and heads home
// (leash has to exceed the view or a soldier drops a target the moment it sees one)
const STEP_WANDER = 0.40 // seconds per cell while loitering
const STEP_CHASE = 0.22 // seconds per cell while closing on a creep
const HOP_HEIGHT = 0.45
const CONTACT_MARGIN = 0.25 // world units of daylight left between the two bodies
const ATTACK_INTERVAL = 0.6 // seconds between blows (both directions)
const SOLDIER_DAMAGE = 1 // damage a soldier does to a creep per blow
const CREEP_DAMAGE = 1 // damage a creep does back
const SOLDIER_HP = 3
const SQUAD_PER_FLOOR = 1 // soldiers a barracks supports per floor
const SPAWN_INTERVAL = 4.0 // seconds between reinforcements
// With nothing to do a soldier stands still half the time. Stepping on every
// beat read as frantic patrolling; loitering makes the garrison look off duty
// until something shows up.
const IDLE_STAND_CHANCE = 0.5
const IDLE_PAUSE = [0.15, 0.6] // seconds between steps when it does move
const IDLE_STAND = [0.8, 2.4] // seconds it stands still when it doesn't

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

export class Soldiers {
  constructor(scene, city, creeps) {
    this.scene = scene
    this.city = city
    this.creeps = creeps
    this.soldiers = []

    this.geo = new BoxGeometry(2, 2, 2) // same unit cube as a creep, scaled down
    // The same grey the walls are built from, so a soldier reads as a piece of
    // your city that got up and walked - and, more usefully, so the only
    // coloured things moving on the board are creeps.
    //
    // No emissive: with bloom in the pipeline anything emissive smears, and the
    // loot crate is the only thing meant to.
    this.mat = new MeshStandardNodeMaterial({
      color: Tower.BASE_COLOR.clone(),
      roughness: 0.5,
      metalness: 0,
    })

    this._c = new Vector2()
    this.cell = city.cellUnit
    this.baseY = 0.6
  }

  /** World-space centre of a tower. */
  towerWorld(tower, out) {
    return towerWorldCenter(tower, this.city, out)
  }

  /** World centre of the cell containing a world point, so every soldier sits
   *  on the same lattice the buildings do. */
  snap(v, offset) {
    return snapToCell(v, this.cell, offset)
  }

  /** True if a world point sits in a cell a soldier can't enter: a building, or
   *  off the board. */
  blocked(x, z) {
    const cell = this.city.worldToCell(x, z)
    if (!cell) return true
    return !!(this.city.occupied[cell.gy] && this.city.occupied[cell.gy][cell.gx])
  }

  /**
   * True if another soldier already holds this cell. A soldier's claim is its
   * DESTINATION (toX/toZ), not where it currently is: two of them mid-hop into
   * the same cell would otherwise both pass the test and land on top of each
   * other. Claiming the target on departure means the cell is reserved for the
   * whole hop.
   */
  taken(x, z, except) {
    for (const o of this.soldiers) {
      if (o === except) continue
      if (Math.abs(o.toX - x) < 0.1 && Math.abs(o.toZ - z) < 0.1) return true
    }
    return false
  }

  /** A cell a soldier may move into: on the board, not a building, unclaimed. */
  cellFree(x, z, except) {
    return !this.blocked(x, z) && !this.taken(x, z, except)
  }

  /**
   * Keep each barracks topped up. A barracks supports SQUAD_PER_FLOOR soldiers
   * per storey, so building it taller is what grows the garrison.
   */
  updateGarrisons(dt) {
    for (const t of this.city.towers) {
      if (!t.visible || !isBarracks(t) || t.numFloors < 1) continue
      if (this.city.upkeep.isDark(t)) continue // browned out
      t.spawnTimer = (t.spawnTimer || 0) - dt
      if (t.spawnTimer > 0) continue
      t.spawnTimer = SPAWN_INTERVAL
      const cap = t.numFloors * (SQUAD_PER_FLOOR + Buffs.squadPerFloor)
      let alive = 0
      for (const s of this.soldiers) if (s.home === t) alive++
      if (alive < cap) this.spawn(t)
    }
  }

  spawn(barracks) {
    const home = new Vector2()
    this.towerWorld(barracks, home)
    // Step out onto the first free cell around the barracks rather than
    // materialising inside it.
    let sx = home.x, sz = home.y
    for (const [dx, dz] of [...DIRS].sort(() => Math.random() - 0.5)) {
      const cx = this.snap(home.x + dx * this.cell, this.city.gridOffsetX)
      const cz = this.snap(home.y + dz * this.cell, this.city.gridOffsetZ)
      if (this.cellFree(cx, cz, null)) { sx = cx; sz = cz; break }
    }

    // Step out from the foot of the barracks onto that free cell - an ordinary
    // walking hop, just starting inside the building.
    const mesh = new Mesh(this.geo, this.mat)
    mesh.scale.setScalar(SIZE)
    mesh.castShadow = true
    mesh.rotation.y = Math.PI / 4
    mesh.position.set(home.x, this.baseY, home.y)
    this.scene.add(mesh)
    this.soldiers.push({
      mesh, home: barracks, homeX: home.x, homeZ: home.y,
      hp: SOLDIER_HP + Buffs.soldierHp, target: null, attackTimer: 0, pause: 0,
      fromX: home.x, fromZ: home.y, toX: sx, toZ: sz, t: 0,
    })
    Sounds.play('pop', 1.6, 0.15, 0.18)
  }

  /** Nearest live creep within `radius` cells of a point, or null. */
  nearestCreep(x, z, radius) {
    const r2 = (radius * this.cell) ** 2
    let best = null, bestD = r2
    for (const c of this.creeps.creeps) {
      if (c.bomber) continue // airborne, soldiers can't reach them
      const dx = c.mesh.position.x - x
      const dz = c.mesh.position.z - z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = c }
    }
    return best
  }

  /** Begin a hop to the neighbouring cell at (dx,dz), if it's free. */
  tryStep(s, dx, dz) {
    const nx = s.toX + dx * this.cell
    const nz = s.toZ + dz * this.cell
    if (!this.cellFree(nx, nz, s)) return false
    s.fromX = s.toX; s.fromZ = s.toZ
    s.toX = nx; s.toZ = nz
    s.t = 0
    // Same footstep the creeps use - both are units hopping cell to cell on the
    // same grid, so they should sound like it.
    Sounds.play(Math.random() < 0.5 ? 'step1' : 'step2', 1.0, 0.2, 0.4)
    return true
  }

  /** Greedy step toward a world point: try the axis with the bigger gap first,
   *  then the other, so a soldier rounds obstacles instead of stalling. */
  stepToward(s, tx, tz) {
    const dx = tx - s.toX, dz = tz - s.toZ
    const sx = Math.sign(dx), sz = Math.sign(dz)
    const order = Math.abs(dx) >= Math.abs(dz)
      ? [[sx, 0], [0, sz]] : [[0, sz], [sx, 0]]
    for (const [ax, az] of order) {
      if ((ax || az) && this.tryStep(s, ax, az)) return true
    }
    return false
  }

  /** Idle move: mostly random, but pulled back when it strays past the leash. */
  stepWander(s) {
    const homeDist = Math.hypot(s.toX - s.homeX, s.toZ - s.homeZ) / this.cell
    if (homeDist > HOME_RADIUS && this.stepToward(s, s.homeX, s.homeZ)) return
    for (const [dx, dz] of [...DIRS].sort(() => Math.random() - 0.5)) {
      if (this.tryStep(s, dx, dz)) return
    }
  }

  kill(s, i) {
    this.city.debris?.spawn(s.mesh.position.x, this.baseY, s.mesh.position.z, 0.4,
      this.city.accentColors[BARRACKS_COLOR], 5)
    this.scene.remove(s.mesh)
    this.soldiers.splice(i, 1)
    Sounds.play('break2', 1.4, 0.2, 0.22)
  }

  update(dt) {
    this.updateGarrisons(dt)

    for (let i = this.soldiers.length - 1; i >= 0; i--) {
      const s = this.soldiers[i]

      // The barracks is gone: the garrison it raised goes with it.
      if (!s.home.visible || !isBarracks(s.home) || s.home.numFloors < 1) { this.kill(s, i); continue }

      const px = s.mesh.position.x, pz = s.mesh.position.z
      const homeDist = Math.hypot(px - s.homeX, pz - s.homeZ) / this.cell

      // Drop a target that died, or that dragged us too far from the barracks.
      if (s.target && (!this.creeps.isAlive(s.target) || homeDist > LEASH_RADIUS)) s.target = null
      if (!s.target) s.target = this.nearestCreep(px, pz, ENGAGE_RADIUS)

      let inContact = false
      if (s.target) {
        const tp = s.target.mesh.position
        // Body to body, not centre to centre. A fixed range is fine against a
        // normal creep and puts a soldier well inside a fat one.
        const reach = SIZE + Creeps.radiusOf(s.target) + CONTACT_MARGIN
        inContact = Math.hypot(tp.x - px, tp.z - pz) <= reach
      }

      if (inContact) {
        // Standing toe to toe: stop stepping, both sides trade on one clock.
        s.attackTimer -= dt
        if (s.attackTimer <= 0) {
          s.attackTimer = ATTACK_INTERVAL
          this.creeps.hit(s.target, SOLDIER_DAMAGE)
          // Same blow the creeps land on buildings - one combat sound for the
          // whole game, pitched up a little because a soldier is a small thing.
          Sounds.play('attack', 1.25, 0.15, 0.4)
          s.hp -= CREEP_DAMAGE
          if (s.hp <= 0) { this.kill(s, i); continue }
        }
      } else if (s.t >= 1) {
        // Landed: dawdle a moment when idle, then pick the next cell.
        s.attackTimer = 0
        s.pause -= dt
        if (s.pause <= 0) {
          if (s.target) {
            this.stepToward(s, s.target.mesh.position.x, s.target.mesh.position.z)
          } else if (Math.random() < IDLE_STAND_CHANCE) {
            s.pause = IDLE_STAND[0] + Math.random() * (IDLE_STAND[1] - IDLE_STAND[0])
          } else {
            this.stepWander(s)
            s.pause = IDLE_PAUSE[0] + Math.random() * (IDLE_PAUSE[1] - IDLE_PAUSE[0])
          }
        }
      }

      // Advance the hop. Same smoothstep + arc the creeps use, so friend and foe
      // read as the same kind of thing moving on the same grid.
      if (s.t < 1) {
        advanceHop(s, dt, {
          duration: s.target ? STEP_CHASE : STEP_WANDER,
          baseY: this.baseY,
          hopHeight: HOP_HEIGHT,
        })
      } else {
        s.mesh.position.set(s.toX, this.baseY, s.toZ)
      }
    }
  }
}
