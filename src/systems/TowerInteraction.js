import { Vector2, Vector3, Box3, Mesh, RingGeometry, MeshBasicNodeMaterial } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR } from '../palette.js'
import { Buffs } from '../buffs.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, isTurret, isGrey, isGenerator, towerArea, towerTopY, GEN_LEVEL_BUDGET } from '../blockTypes.js'

/**
 * TowerInteraction - all player input on towers (hover, build, destroy, place,
 * demolish) plus the center-lot right-click reroll build-wheel. The tower
 * mutations it triggers (rerollTower) live on the TowerRenderer; onTowerChanged
 * is City's coordinator hub.
 */
export class TowerInteraction {
  constructor(city) {
    this.city = city
    this.pointer = null // set by Demo

    // Click / drag detection
    this.hoveredTower = null
    this.pressedTower = null
    this.pointerDownPos = new Vector2()
    this.dragThreshold = 5 // pixels
    this._pickBox = new Box3()
    this._pickHit = new Vector3()

    // Reroll build-wheel timers: {tower, ring, mat, t, step}
    this.rerollTimers = []
    this.rerollDuration = 5 // seconds for a rerolled block to spawn
    this.rerollSteps = 48 // discrete fill steps of the ring
    // Cached fill geometries (step -> RingGeometry), NEVER disposed (swapping a
    // live mesh's .geometry triggers a WebGPU setIndexBuffer crash).
    this.rerollRingGeos = new Map()
  }

  /**
   * Pick the nearest tower by its bounding box (ignores actual geometry so the
   * hole in plus blocks stays clickable). Returns {batchId} or null.
   */
  pickTowerBox(ray) {
    const city = this.city
    let nearest = null
    let nearestDist = Infinity
    for (const tower of city.towers) {
      if (!tower.visible) continue
      // Box top = real geometry top (a 0-floor tower is just the thin roof tile).
      this._pickBox.min.set(tower.box.min.x + city.gridOffsetX, 0, tower.box.min.y + city.gridOffsetZ)
      this._pickBox.max.set(
        tower.box.max.x + city.gridOffsetX, towerTopY(tower, city.floorHeight),
        tower.box.max.y + city.gridOffsetZ
      )
      const hit = ray.intersectBox(this._pickBox, this._pickHit)
      if (!hit) continue
      const d = ray.origin.distanceToSquared(hit)
      if (d < nearestDist) { nearestDist = d; nearest = tower }
    }
    return nearest ? { batchId: nearest.roofInstance } : null
  }

  towerFor(intersection) {
    if (intersection && intersection.batchId !== undefined) {
      return this.city.instanceToTower.get(intersection.batchId)
    }
    return null
  }

  /** Hover highlight, swapping the lit accent on enter/leave. */
  onHover(intersection) {
    const tower = this.towerFor(intersection)
    if (tower === this.hoveredTower) return
    if (this.hoveredTower) this.hoveredTower.animateHoverColor(this.city.towerMesh, false)
    this.hoveredTower = tower
    if (tower) tower.animateHoverColor(this.city.towerMesh, true)
  }

  /** Pointer down: record the pressed tower + position for click/drag detection. */
  onPointerDown(intersection, clientX, clientY, isTouch) {
    if (isTouch) return false // touch is resolved on pointer up to not fight pan
    const tower = this.towerFor(intersection)
    this.pointerDownPos.set(clientX, clientY)
    this.pressedTower = tower && tower.visible ? tower : null
    return false // let OrbitControls handle drag
  }

  /** Cancel the pending click once the pointer drags past the threshold. */
  onPointerMove(clientX, clientY) {
    if (!this.pressedTower) return
    const dx = clientX - this.pointerDownPos.x
    const dy = clientY - this.pointerDownPos.y
    if (Math.hypot(dx, dy) > this.dragThreshold) this.pressedTower = null
  }

  /** Pointer up: build a floor on the pressed tower, else click a lot/empty slot. */
  onPointerUp(isTouch, touchIntersection) {
    if (isTouch) {
      const tower = this.towerFor(touchIntersection)
      if (tower && tower.visible) this.buildFloor(tower)
      else if (this.pointer) this.clickGround()
      return
    }

    const tower = this.pressedTower
    this.pressedTower = null
    if (tower) { this.buildFloor(tower); return }

    // No tower pressed: if this wasn't a drag, try the ground under the cursor.
    if (!this.pointer) return
    const up = this.pointer.clientPointer
    if (Math.hypot(up.x - this.pointerDownPos.x, up.y - this.pointerDownPos.y) > this.dragThreshold) return
    this.clickGround()
  }

  buildFloor(tower) {
    const city = this.city
    if (!this.canBuild(tower)) return
    if (isGenerator(tower)) tower.genLevelsAdded = (tower.genLevelsAdded || 0) + 1
    tower.handleClick(city, city.floorHeight, city.maxFloors, city.debris,
      city.towers, () => city.onTowerChanged(tower), () => city.updateTowerVisuals())
  }

  /** Click a dormant lot to add growth points. Empty slots are filled by the
   *  tile palette (drag), not by clicking. */
  clickGround() {
    const p = this.pointer.scenePointer
    this.city.lotGrowth.clickLot(p.x, p.z)
  }

  /**
   * Whether a build click should proceed (and charge mana). Path generators and
   * turrets cost 2 per floor, else 1, scaled by footprint area.
   */
  canBuild(tower) {
    const city = this.city
    if (tower.numFloors >= city.maxFloors) {
      Sounds.play('error', 1.0, 0.2, 0.5) // already at max height
      return false
    }
    // Generators only ever accept GEN_LEVEL_BUDGET floors across their whole
    // life, however many times you rebuild them. Once that's spent it's a dead
    // husk - stop taking the player's energy for a floor that won't stick.
    if (isGenerator(tower) && (tower.genLevelsAdded || 0) >= GEN_LEVEL_BUDGET) {
      Sounds.play('error', 1.0, 0.2, 0.5)
      return false
    }
    if (!city.mana) return true
    // Walls (grey) cost 1/cell; generators + turrets cost 2/cell (same rule as
    // placing a tile from the palette).
    const cost = Math.max(1, Math.round(
      (isGrey(tower) ? 1 : 2) * towerArea(tower, city.cellUnit, city.towerSize) * Buffs.buildCost
    ))
    if (!city.freeClicks && !city.mana.spend(cost)) {
      Sounds.play('no-money', 1.0, 0.06, 0.55) // can't afford this build
      return false
    }
    // Floating "-cost" caption rising off the tower (like a placement / gen pulse).
    if (!city.freeClicks && city.floatingText) {
      const c = tower.box.getCenter(city.towerCenter)
      city.floatingText.spawn(c.x + city.gridOffsetX, towerTopY(tower, city.floorHeight) + 0.5,
        c.y + city.gridOffsetZ, `-${cost}`, ENERGY_COLOR, 0, null)
    }
    return true
  }

  /** Right-click a tower to demolish it (any tile, including the pre-built center
   *  lot): built tiles stagger-delete then free their cell; flat tiles pop. */
  onRightClick(intersection) {
    const city = this.city
    const tower = this.towerFor(intersection)
    if (!tower || !tower.visible || tower.king) return // the king can't be demolished
    if (tower.numFloors >= 1) {
      tower.animateDelete(city.towerMesh, city.floorHeight, tower.numFloors, () => city.demolishTower(tower))
    } else {
      const c = tower.box.getCenter(city.towerCenter)
      city.debris.spawn(c.x + city.gridOffsetX, 0.5, c.y + city.gridOffsetZ, 0.8, tower.litColor || tower.baseColor, 10)
      Sounds.play('break2', 1.0, 0.2)
      city.demolishTower(tower)
    }
  }

  /** Hide the tower and spin a radial build-wheel; finishReroll() on completion. */
  beginReroll(tower) {
    const city = this.city
    tower.visible = false
    tower.numFloors = 0
    city.updateTowerMatrices(tower)
    city.onTowerChanged(tower)

    const center = tower.box.getCenter(city.towerCenter)
    const mat = new MeshBasicNodeMaterial({
      color: city.accentColors[tower.colorIndex].clone(),
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    })
    const ring = new Mesh(this.rerollRingGeoFor(0), mat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(center.x + city.gridOffsetX, 0.12, center.y + city.gridOffsetZ)
    ring.renderOrder = 6
    city.scene.add(ring)
    this.rerollTimers.push({ tower, ring, mat, t: 0, step: 0 })
  }

  /** Cached clockwise-fill annulus for a discrete fill step (0..rerollSteps). */
  rerollRingGeoFor(step) {
    let g = this.rerollRingGeos.get(step)
    if (!g) {
      const inner = this.city.cellUnit * 0.26
      const outer = this.city.cellUnit * 0.42
      const len = Math.max(0.0001, (step / this.rerollSteps) * Math.PI * 2)
      const start = Math.PI / 2 - len // grow clockwise from 12 o'clock
      g = new RingGeometry(inner, outer, 48, 1, start, len)
      this.rerollRingGeos.set(step, g)
    }
    return g
  }

  /** Reveal the rerolled slot with a fresh random block. */
  finishReroll(tower) {
    const city = this.city
    tower.emptyTower = false
    tower.visible = true
    tower.numFloors = 0
    city.renderer.rerollTower(tower)
    city.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15, 0.7)
    city.onTowerChanged(tower)
  }

  /** Advance build-wheels; rebuild the mesh per fill step, spawn on completion. */
  update(dt) {
    const city = this.city
    for (let i = this.rerollTimers.length - 1; i >= 0; i--) {
      const rt = this.rerollTimers[i]
      rt.t += dt
      const p = Math.min(1, rt.t / this.rerollDuration)
      const step = Math.min(this.rerollSteps, Math.floor(p * this.rerollSteps))
      if (step !== rt.step) {
        rt.step = step
        const old = rt.ring
        const ring = new Mesh(this.rerollRingGeoFor(step), rt.mat)
        ring.rotation.copy(old.rotation)
        ring.position.copy(old.position)
        ring.renderOrder = old.renderOrder
        city.scene.add(ring)
        city.scene.remove(old)
        rt.ring = ring
      }
      if (p >= 1) {
        city.scene.remove(rt.ring)
        this.rerollTimers.splice(i, 1)
        this.finishReroll(rt.tower)
      }
    }
  }
}
