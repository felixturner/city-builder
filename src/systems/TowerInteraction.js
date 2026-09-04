import { Vector2, Vector3, Box3, Mesh, RingGeometry, MeshBasicNodeMaterial } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { ENERGY_COLOR } from '../palette.js'
import { Buffs } from '../buffs.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, isWall, claimsEnclosure, towerArea, towerTopY, maxFloorsFor } from '../blockTypes.js'
import { fxMaterial, glow } from '../fx.js'
import { priceOfTower, refundOfTower } from './tileCost.js'

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
    this._cellBox = new Box3()
    this._cellHit = new Vector3()

    // Reroll build-wheel timers: {tower, ring, mat, t, step}
    this.rerollTimers = []
    this.rerollDuration = 5 // seconds for a rerolled block to spawn
    this.rerollSteps = 48 // discrete fill steps of the ring
    // Cached fill geometries (step -> RingGeometry), NEVER disposed (swapping a
    // live mesh's .geometry triggers a WebGPU setIndexBuffer crash).
    this.rerollRingGeos = new Map()
  }

  /**
   * Pick the nearest tower by its FOOTPRINT CELLS. Cells, not geometry, so the
   * hole in plus blocks stays clickable - but not the bounding box either,
   * because a tetromino fills only four of its box's six cells and the other
   * two would shadow their neighbours for the tower's full height. A one-floor
   * tile in a five-floor L-piece's notch was unclickable. Returns {batchId} or
   * null.
   *
   * Two phases, because hover runs this on every pointer move against the whole
   * pool: the bounding box rejects almost every tower for one intersect each,
   * and only a survivor pays for its handful of cells.
   */
  pickTowerBox(ray) {
    const city = this.city
    const cu = city.cellUnit
    let nearest = null
    let nearestDist = Infinity
    for (const tower of city.towers) {
      if (!tower.visible) continue
      // Box top = the SOLID blocks only - no roof cap, no turret model. The
      // decoration above the blocks is mostly air, and counting it let a tall
      // neighbour's empty box corner steal clicks aimed at a low block behind it.
      const top = tower.numFloors * city.floorHeight
      this._pickBox.min.set(tower.box.min.x + city.gridOffsetX, 0, tower.box.min.y + city.gridOffsetZ)
      this._pickBox.max.set(
        tower.box.max.x + city.gridOffsetX, top, tower.box.max.y + city.gridOffsetZ
      )
      if (!ray.intersectBox(this._pickBox, this._pickHit)) continue
      // The box entry is a lower bound on any cell hit inside it, so a tower
      // that enters behind the best hit so far cannot beat it. Skip the cells.
      let d = ray.origin.distanceToSquared(this._pickHit)
      if (d >= nearestDist) continue

      // Pre-built lot towers carry no cell list; their box is their footprint.
      if (tower.cells) {
        d = Infinity
        for (const [dx, dy] of tower.cells) {
          const x0 = (tower.cellX + dx) * cu + city.gridOffsetX
          const z0 = (tower.cellY + dy) * cu + city.gridOffsetZ
          this._cellBox.min.set(x0, 0, z0)
          this._cellBox.max.set(x0 + cu, top, z0 + cu)
          if (!ray.intersectBox(this._cellBox, this._cellHit)) continue
          d = Math.min(d, ray.origin.distanceToSquared(this._cellHit))
        }
        if (d >= nearestDist) continue
      }
      nearestDist = d
      nearest = tower
    }
    return nearest ? { batchId: nearest.roofInstance } : null
  }

  towerFor(intersection) {
    if (intersection && intersection.batchId !== undefined) {
      return this.city.instanceToTower.get(intersection.batchId)
    }
    return null
  }

  /**
   * Track which tower the pointer is over.
   *
   * No colour change any more. Towers used to lighten on hover, which fought
   * everything else painted on a stack - the height gradient, the lit accent, a
   * damage flash - and the tween that did it wrote whatever colour the tower
   * happened to be showing at the time back as its "original".
   *
   * `hoveredTower` is still tracked: other things read it.
   */
  onHover(intersection) {
    this.hoveredTower = this.towerFor(intersection)
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

  /**
   * One click, `Buffs.floorsPerBuild` floors - each one checked and charged for
   * on its own, so Double Time buys ACTIONS and never free height. It stops
   * early on anything that would block a plain click: the cap, the bar, a tile
   * a creep took in the meantime.
   *
   * Recorded ONCE, whatever the buff says. The buff is deterministic and
   * playback has the same one, so a second record would build the extra floors
   * twice over on replay.
   */
  /** How high a "-cost" / "+refund" caption floats above a tower: a whole floor
   *  clear of the roof, so it reads against the sky rather than against the
   *  block it is describing. */
  _captionY(tower) {
    return towerTopY(tower, this.city.floorHeight) + 0.5 + this.city.floorHeight
  }

  buildFloor(tower) {
    const city = this.city
    if (!this.canBuild(tower)) return
    // The tower's INDEX, not just its cell. Playback names a tile by its origin
    // cell, which `towerAtCell` resolves - but the pool array is fixed for the
    // life of the run, so an index names the tile exactly and costs nothing.
    // The cell stays for readability.
    city.demo?.run?.record('floor', { gx: tower.cellX, gy: tower.cellY, i: city.towers.indexOf(tower) })
    this._raiseOneFloor(tower)
    for (let n = 1; n < Buffs.floorsPerBuild; n++) {
      if (!this.canBuild(tower)) return
      this._raiseOneFloor(tower)
    }
  }

  /** The build itself, with no recording - see buildFloor. */
  _raiseOneFloor(tower) {
    const city = this.city
    tower.handleClick(city, city.floorHeight, maxFloorsFor(tower), city.debris,
      city.towers, () => city.onTowerChanged(tower), () => {
        city.updateTowerVisuals()
        this.announceGenHeight(tower)
      })
  }

  /**
   * An enclosure generator just gained a floor: float what that bought.
   *
   * Its output is enclosed cells x floors, and nothing on screen says so in the
   * moment you pay for it, so the caption names the multiplier against a
   * one-storey tile. Support generators get no caption - height there is reach, and
   * the ring on the ground already shows you the reach.
   */
  announceGenHeight(tower) {
    const n = tower.numFloors
    if (n < 2 || !claimsEnclosure(tower)) return // x1 is not news
    this.city.energy.spawnTowerText(tower, `x${n} energy`, ENERGY_COLOR, 'gen-online', 0)
  }

  /** Click a dormant lot to add growth points. Empty slots are filled by the
   *  tile palette (drag), not by clicking. */
  clickGround() {
    const p = this.pointer.scenePointer
    this.city.lotGrowth.clickLot(p.x, p.z)
  }

  /**
   * Whether a build click should proceed (and charge mana). Support generators and
   * turrets cost 2 per floor, else 1, scaled by footprint area.
   */
  canBuild(tower) {
    const city = this.city
    // Still standing?
    //
    // The press captures a tower OBJECT on pointer-down and builds on it at
    // pointer-up, which can be most of a second later - long enough for a creep
    // to take its last block. `freePlacedTower` then leaves it invisible, zero
    // floors and back in the pool, and none of the checks below noticed: zero
    // is under the height cap, so the click was charged for and `handleClick`
    // set numFloors on a tile that is not on the board.
    //
    // It also forked replays. The action records the tower's CELL, and on
    // playback that cell is empty, so the build the live run made simply did
    // not happen - identical inputs, different boards, and everything after it
    // diverging from a click that should never have been allowed.
    if (!tower.visible || tower.numFloors < 1) return false
    // The king's height IS its health - building it back up would make the one
    // loss condition in the game something you can simply pay off.
    if (tower.king) {
      Sounds.play('error', 1.0, 0.06, 0.35)
      return false
    }
    // Turrets top out two storeys above everything else (see maxFloorsFor).
    if (tower.numFloors >= maxFloorsFor(tower)) {
      // Same cue as "can't afford it": both are "that click did nothing", and
      // two different blips for the same non-event just read as inconsistency.
      Sounds.play('error', 1.0, 0.06, 0.35) // already at max height
      return false
    }
    if (!city.mana) return true
    // Exactly what the same thing costs from the tray - one shared price
    // function, so raising a wall can never drift away from buying one.
    const cost = priceOfTower(city, tower)
    if (!city.freeClicks && !city.mana.spend(cost, false, true)) { // true: a floor, not a new tile
      Sounds.play('error', 1.0, 0.06, 0.35) // can't afford this build
      return false
    }
    // Floating "-cost" caption rising off the tower (like a placement / gen pulse).
    if (!city.freeClicks && city.floatingText) {
      const c = tower.box.getCenter(city.towerCenter)
      city.floatingText.spawn(c.x + city.gridOffsetX, this._captionY(tower),
        c.y + city.gridOffsetZ, `-${cost}`, ENERGY_COLOR, 0, null)
    }
    return true
  }

  /** Right-click a tower to demolish it (any tile, including the pre-built center
   *  lot): the stack falls floor by floor, then the cell is freed. */
  onRightClick(intersection) {
    const city = this.city
    const tower = this.towerFor(intersection)
    if (!tower || !tower.visible || tower.king) return // the king can't be demolished
    this.demolishTower(tower)
  }

  /**
   * Tear a tower down.
   *
   * The tower is removed from the world NOW; the stack falling floor by floor is
   * what you watch afterwards.
   *
   * It used to be the other way round - the removal ran from the fall
   * animation's onComplete, most of a second of WALL CLOCK later - so a
   * demolished tower went on blocking creep paths, sealing enclosures and
   * counting as a wall for the whole animation. A recorded run replayed at 4x
   * left it standing four times as long in world terms, and the board ended up
   * different. Game state should not be waiting on an animation to finish.
   *
   * The fall is played by a stand-in that owns the instances until it lands (see
   * City.demolishTower), so nothing is drawing to a slot the pool has handed out
   * again.
   */
  demolishTower(tower) {
    const city = this.city
    city.demo?.run?.record('demolish', { gx: tower.cellX, gy: tower.cellY, i: city.towers.indexOf(tower) })
    // Half of what its floors cost, handed back - so tearing something down is a
    // move you can make when you are desperate rather than a pure loss. Taken
    // before the tower is freed, while it still has its height.
    const refund = refundOfTower(city, tower)
    // Its height too, and for the same reason: the caption rises from the top
    // of what you just tore down, and by the time it spawns the stack is
    // already falling and the floor count on its way to zero.
    const topY = this._captionY(tower)
    // Over the top of the fall, which brings its own per-floor ticks and the
    // roof landing: those are the stack coming down, this is the player having
    // torn it down. Only here, so a creep taking the last block never gets it.
    Sounds.play('demolish', 1.0, 0.2, 0.3)
    city.demolishTower(tower, { animate: true })
    if (refund > 0 && city.mana) {
      city.mana.add(refund)
      const c = tower.box.getCenter(city.towerCenter)
      city.floatingText?.spawn(
        // No sound on the refund caption: the demolish thud, a tick per floor
        // and the roof landing are already playing over each other, and a
        // chime on top of that was one thing too many.
        c.x + city.gridOffsetX, topY, c.y + city.gridOffsetZ,
        `+${refund}`, ENERGY_COLOR, 0, null
      )
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
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: city.accentColors[tower.accentIndex].clone(),
      opacity: 0.85,
    }))
    const ring = glow(new Mesh(this.rerollRingGeoFor(0), mat))
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
    tower.numFloors = 1 // same as a freshly dropped tile: one block + roof
    city.renderer.rerollTower(tower)
    city.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15, 0.6)
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
