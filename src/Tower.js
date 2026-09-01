import { Box2, Color, Object3D, Vector2, MathUtils } from 'three/webgpu'
import gsap from 'gsap'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { TetrominoGeometry } from './lib/TetrominoGeometry.js'
import { roofGeomIndex, maxFloorsFor } from './blockTypes.js'
import { Sounds } from './lib/Sounds.js'

/**
 * Tower class - represents a building/stack of blocks
 * Contains a top block (roof) and multiple base blocks (floors)
 */
export class Tower {

  /**
   * One grey for every wall. Walls used to draw a random shade from a list of
   * four, which meant colour carried no information - a short pale wall and a
   * tall dark one looked unrelated. With a single base colour the per-floor
   * gradient (see shadeForFloor) is the ONLY thing varying, so shade reads
   * purely as height.
   *
   * Light on purpose: this is the colour of a freshly placed, zero-level tile,
   * and shadeForFloor only ever darkens from here - so the lighter the base, the
   * more range the height gradient has to work with.
   *
   * Everything picks an index via COLORS.length, so a one-entry list is safe.
   */
  static COLORS = [
    new Color(0xbcbcbc),
  ]

  /**
   * How far the top floor of a full-height stack is pushed toward black. Each
   * floor is its own BatchedMesh instance with its own colour, so a stack can
   * carry a gradient for free - no extra draw calls, no extra geometry.
   */
  static STACK_DARKEN = 0.55

  /** Shade for floor `f` of a stack: floor 0 keeps `base`, higher floors lerp
   *  toward black so a wall reads DARKER the taller it gets. */
  static shadeForFloor(base, f, maxFloors, out) {
    const t = maxFloors > 1 ? (f / (maxFloors - 1)) * Tower.STACK_DARKEN : 0
    return out.copy(base).lerp(Tower.BLACK, t)
  }

  static BLACK = new Color(0x000000)

  /**
   * Roofs get slightly darker vertex colour than the block they cap: a roof's
   * top face points at the key light while the wall below only shows side
   * faces, so identical RGB renders lighter up there. 1.0 disables it.
   */
  static ROOF_SHADE_BIAS = 0.9

  /** The colour a tower's roof should be: the shade of the highest block under
   *  it, with the lighting bias applied. Single source for the renderer AND the
   *  hover tween - the tween used to write flat topColor here, which quietly
   *  undid the stack gradient every time the pointer crossed a tower. */
  static roofShade(tower, base, out) {
    // The tower's CAP, not how many instance slots it was handed. Every tower is
    // allocated enough blocks to become a turret, so slot count would stretch a
    // wall's gradient over seven storeys it can never build.
    const n = maxFloorsFor(tower)
    Tower.shadeForFloor(base, Math.max(0, tower.numFloors - 1), n, out)
    return out.multiplyScalar(Tower.ROOF_SHADE_BIAS)
  }

  static ID = 0
  static BASE_COLOR = new Color(0xbcbcbc) // matches COLORS[0] so rects and tetro walls read alike

  constructor() {
    this.id = Tower.ID++
    this.typeBottom = 0 // Base block geometry type
    this.typeTop = 0    // Top block geometry type
    this.box = new Box2()
    this.numFloors = 0  // Height in floors. A LIVE tile is always >= 1; 0 only ever means a pooled/hidden slot.
    this.rotation = 0
    this.topColorIndex = 0
    this.topColor = Tower.COLORS[this.topColorIndex]
    this.baseColor = Tower.BASE_COLOR
    this.skipFactor = 0 // For realtime visibility toggle
    this.colorIndex = 0 // Hover color index
    this.visible = true
    this.empty = false // permanent inactive slot (a pre-baked gap)
    this.emptyTower = false // demolished tower: grey floor outline, click to regen


    // Instance IDs for BatchedMesh
    this.floorInstances = [] // Base block instance IDs
    this.roofInstance = null // Top block instance ID

    // Animation state
    this.hoverTween = null
    this.floorTween = null
    this.roofTween = null // Separate tween for roof Y position (persists across clicks)
    // Persistent roof animation state (so GSAP can tween from current values)
    this.roofAnim = { y: 0, tiltX: 0, tiltY: 0, tiltZ: 0 }
    // Persistent dummy for roof animation (avoids stale closures)
    this.roofDummy = new Object3D()
    // Flag to prevent external matrix updates from overwriting animated roof
    this.roofAnimating = false
  }

  setTopColorIndex(index) {
    this.topColorIndex = index
    this.topColor = Tower.COLORS[this.topColorIndex]
  }

  /**
   * Lighten a color by increasing its HSL lightness
   */
  static lightenColor(color, amount = 0.15) {
    const hsl = {}
    color.getHSL(hsl)
    return new Color().setHSL(hsl.h, hsl.s, Math.min(1, hsl.l + amount))
  }

  /**
   * Animate tower color to/from hover state using a single tween
   * @param {BatchedMesh} mesh - The batched mesh containing this tower's instances
   * @param {boolean} isHovering - True to lighten colors, false to restore original
   * @param {number} floorHeight - Height of each floor for calculating visible floors
   */
  animateHoverColor(mesh, isHovering) {
    // Kill any existing hover tween
    if (this.hoverTween) {
      this.hoverTween.kill()
    }

    const numFloors = this.numFloors
    const floorInstances = this.floorInstances
    const roofInstance = this.roofInstance

    // Get current colors from first floor and roof
    const currentFloorColor = new Color()
    const currentRoofColor = new Color()
    mesh.getColorAt(floorInstances[0], currentFloorColor)
    mesh.getColorAt(roofInstance, currentRoofColor)

    // Target colors - lighten current colors when hovering, restore original otherwise
    let toFloorColor, toRoofColor
    if (isHovering) {
      // Lighten the base colors for hover effect
      const baseFloor = this.isLit && this.litColor ? this.litColor : this.baseColor
      const baseRoof = this.isLit && this.litColor ? this.litColor : this.topColor
      toFloorColor = Tower.lightenColor(baseFloor)
      // Lighten the roof's SHADED colour, not the flat base, or hovering resets
      // it to a colour it should never have had.
      toRoofColor = Tower.lightenColor(Tower.roofShade(this, baseRoof, new Color()))
    } else if (this.isLit && this.litColor) {
      // Lit towers stay at their lit color
      toFloorColor = this.litColor.clone()
      toRoofColor = this.litColor.clone()
    } else {
      toFloorColor = this.baseColor
      toRoofColor = Tower.roofShade(this, this.baseColor, new Color())
    }

    // Interpolation colors
    const floorColor = currentFloorColor.clone()
    const roofColor = currentRoofColor.clone()
    // floorInstances[0] was sampled above, so `current`/`to` are both floor-0
    // shades; the gradient is re-applied per floor in onUpdate.
    const _shade = new Color()
    const maxFloorsForShade = maxFloorsFor(this)

    // Animation state object
    const anim = { t: 0 }

    // Single tween that updates all blocks
    this.hoverTween = gsap.to(anim, {
      t: 1,
      duration: 0.3,
      onUpdate: () => {
        // Interpolate colors
        floorColor.copy(currentFloorColor).lerp(toFloorColor, anim.t)
        roofColor.copy(currentRoofColor).lerp(toRoofColor, anim.t)

        // Apply to all visible floors, re-deriving each floor's shade so the
        // stack gradient survives the hover instead of flattening to one colour.
        for (let f = 0; f < numFloors; f++) {
          Tower.shadeForFloor(floorColor, f, maxFloorsForShade, _shade)
          mesh.setColorAt(floorInstances[f], _shade)
        }
        // Apply to roof
        mesh.setColorAt(roofInstance, roofColor)
      }
    })
  }


  /**
   * Land any in-flight roof animation in its FINISHED state, immediately.
   *
   * kill() on its own stops a tween where it stands: the tilt keeps whatever
   * value the bounce had reached, roofAnimating stays true, and since
   * City.updateTowerMatrices deliberately skips the roof while that flag is set,
   * nothing ever corrects either one. That is both reported bug - the roof left
   * permanently tilted, and (on a tower recycled through the pool with the flag
   * still stuck) the roof left at some previous tile's footprint scale, which
   * reads as a roof several times too big.
   *
   * progress(1, true) fast-forwards the timeline to its end values while
   * suppressing callbacks, so an interrupted pop does not fire its landing
   * thunk. The explicit zeroing then guarantees a clean rest state even if the
   * timeline is swapped out mid-build.
   */
  settleRoof() {
    if (this.roofTween) {
      this.roofTween.progress(1, true)
      this.roofTween.kill()
      this.roofTween = null
    }
    this.roofAnim.tiltX = 0
    this.roofAnim.tiltY = 0
    this.roofAnim.tiltZ = 0
    this.roofAnimating = false
  }

  /** Same idea for the floor timeline: finish it rather than freeze it. */
  settleFloors() {
    if (this.floorTween) {
      this.floorTween.progress(1, true)
      this.floorTween.kill()
      this.floorTween = null
    }
  }

  /**
   * Full animation reset, for a tower going back to the pool.
   *
   * roofAnim.y is included because animateAddFloor only seeds it when it reads
   * 0 - a recycled tower carrying a stale height would start its first pop from
   * the wrong place.
   */
  resetAnimation() {
    this.settleRoof()
    this.settleFloors()
    if (this.hoverTween) { this.hoverTween.kill(); this.hoverTween = null }
    this.roofAnim.y = 0
  }

  /**
   * Animate tower vertical offset (for press down effect)
   * @param {BatchedMesh} mesh - The batched mesh
   * @param {number} floorHeight - Height of each floor
   * @param {number} maxFloors - Maximum number of floors
   * @param {number} offset - Target Y offset
   * @param {number} duration - Animation duration
   * @param {Function} onComplete - Callback when animation completes
   */
  animateOffset(mesh, floorHeight, maxFloors, offset, duration, onComplete) {
    // Use local dummy to avoid conflicts with other animations
    const dummy = new Object3D()
    const center = this.box.getCenter(new Vector2())
    const size = this.box.getSize(new Vector2())
    const ex = this.tetro ? 1 : size.x // tetromino geometry is already cell-scaled
    const ez = this.tetro ? 1 : size.y
    const numFloors = this.numFloors

    // Half-heights for centered geometries
    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = this.tetro ? TetrominoGeometry.roofHalf : BlockGeometry.halfHeights[roofGeomIndex(this.typeTop)]

    // Animate all floor instances
    const anim = { offset: 0 }
    const self = this
    gsap.to(anim, {
      offset: offset,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        for (let f = 0; f < numFloors; f++) {
          const idx = this.floorInstances[f]
          dummy.position.set(center.x, f * floorHeight + floorHalfHeight + anim.offset, center.y)
          dummy.scale.set(ex, floorHeight, ez)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(idx, dummy.matrix)
        }
        // Only update roof if not being animated separately
        if (!self.roofAnimating) {
          dummy.position.set(center.x, numFloors * floorHeight + roofHalfHeight + anim.offset, center.y)
          dummy.scale.set(ex, 1, ez)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(this.roofInstance, dummy.matrix)
        }
      },
      onComplete: onComplete
    })
  }

  /**
   * Rattle the whole stack for a moment when something hits it - the same
   * feedback the creeps got, so you can see WHICH wall is being chewed on
   * without watching a floor count.
   *
   * Writes instance matrices directly, the way animateOffset does: these are
   * BatchedMesh instances, so there is no per-object transform to nudge. The
   * jitter is horizontal only - a vertical one is the press-down that a click
   * already means, and the two would read as the same event.
   *
   * `onSettle` puts the resting matrices back; the tween never writes them
   * itself, because by the time it ends the tower may have lost a floor.
   */
  shakeHit(mesh, floorHeight, amount, duration, onSettle) {
    this.shakeTween?.kill()
    const dummy = new Object3D()
    const center = this.box.getCenter(new Vector2())
    const size = this.box.getSize(new Vector2())
    const ex = this.tetro ? 1 : size.x // tetromino geometry is already cell-scaled
    const ez = this.tetro ? 1 : size.y
    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = this.tetro
      ? TetrominoGeometry.roofHalf
      : BlockGeometry.halfHeights[roofGeomIndex(this.typeTop)]

    const anim = { t: 1 }
    this.shakeTween = gsap.to(anim, {
      t: 0,
      duration,
      ease: 'none',
      onUpdate: () => {
        // A creep can destroy the tower mid-shake; the instances go back to the
        // pool and are handed straight out as some other tile.
        if (!this.visible) return
        const a = anim.t * amount
        const dx = (Math.random() * 2 - 1) * a
        const dz = (Math.random() * 2 - 1) * a
        // Re-read the floor count every frame - a hit that lands during the
        // shake takes one off, and the removed instance is hidden by the
        // matrix refresh that damage triggers.
        const numFloors = this.numFloors
        for (let f = 0; f < numFloors; f++) {
          dummy.position.set(center.x + dx, f * floorHeight + floorHalfHeight, center.y + dz)
          dummy.scale.set(ex, floorHeight, ez)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(this.floorInstances[f], dummy.matrix)
        }
        if (!this.roofAnimating) {
          dummy.position.set(center.x + dx, numFloors * floorHeight + roofHalfHeight, center.y + dz)
          dummy.scale.set(ex, 1, ez)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(this.roofInstance, dummy.matrix)
        }
      },
      onComplete: () => { this.shakeTween = null; onSettle?.() },
    })
  }

  /**
   * Animate adding a new floor with roof pop-off effect
   */
  animateNewFloor(mesh, floorHeight, oldNumFloors, hoverColor, onComplete, onFloorPop) {
    const dummy = new Object3D()
    const center = this.box.getCenter(new Vector2())
    const size = this.box.getSize(new Vector2())
    const ex = this.tetro ? 1 : size.x
    const ez = this.tetro ? 1 : size.y

    this.settleFloors()

    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = this.tetro ? TetrominoGeometry.roofHalf : BlockGeometry.halfHeights[roofGeomIndex(this.typeTop)]
    const newFloorIdx = this.floorInstances[oldNumFloors]
    const newFloorY = oldNumFloors * floorHeight + floorHalfHeight
    const finalRoofY = (oldNumFloors + 1) * floorHeight + roofHalfHeight

    // Initialize roofAnim.y on first click
    if (this.roofAnim.y === 0) {
      this.roofAnim.y = oldNumFloors * floorHeight + roofHalfHeight + floorHeight * 0.2
    }

    // Use hover color directly for new floors
    mesh.setColorAt(newFloorIdx, hoverColor)

    const anim = {
      scale: 0.1,
      yOffset: 0,
      tiltX: 0, tiltY: 0, tiltZ: 0,
      baseOffset: floorHeight * 0.2
    }
    const tiltTarget = {
      x: MathUtils.randFloatSpread(0.2),
      y: MathUtils.randFloatSpread(0.4),
      z: MathUtils.randFloatSpread(0.2)
    }

    const updateFloor = () => {
      dummy.position.set(center.x, newFloorY + anim.yOffset, center.y)
      dummy.scale.set(ex * anim.scale, floorHeight * anim.scale, ez * anim.scale)
      dummy.rotation.set(anim.tiltX, this.rotation + anim.tiltY, anim.tiltZ)
      dummy.updateMatrix()
      mesh.setMatrixAt(newFloorIdx, dummy.matrix)
    }

    const tl = gsap.timeline({
      onComplete: () => { this.floorTween = null; onComplete?.() }
    })
    this.floorTween = tl
    tl.timeScale(0.5)

    // Existing floors settle down
    tl.to(anim, {
      baseOffset: 0,
      duration: 0.12,
      ease: 'power2.out',
      onUpdate: () => {
        for (let f = 0; f < oldNumFloors; f++) {
          dummy.position.set(center.x, f * floorHeight + floorHalfHeight + anim.baseOffset, center.y)
          dummy.scale.set(ex, floorHeight, ez)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(this.floorInstances[f], dummy.matrix)
        }
      }
    }, 0)

    // New floor scales in + pops up
    tl.to(anim, {
      scale: 1,
      yOffset: floorHeight * 0.5,
      tiltX: tiltTarget.x, tiltY: tiltTarget.y, tiltZ: tiltTarget.z,
      duration: 0.1,
      ease: 'power2.out',
      onStart: () => mesh.setVisibleAt(newFloorIdx, true),
      onUpdate: updateFloor,
      onComplete: onFloorPop
    }, 0)

    // New floor settles down
    tl.to(anim, {
      yOffset: 0, tiltX: 0, tiltY: 0, tiltZ: 0,
      duration: 0.07,
      ease: 'bounce.out',
      onUpdate: updateFloor
    }, 0.11)

    // Roof animation (separate)
    this.startRoofAnimation(mesh, center, size, floorHeight, finalRoofY)
  }

  /**
   * Animate roof pop-off (separate from floor timeline for fast-click support)
   */
  startRoofAnimation(mesh, center, size, floorHeight, finalRoofY) {
    this.settleRoof()
    this.roofAnimating = true

    const ex = this.tetro ? 1 : size.x
    const ez = this.tetro ? 1 : size.y
    const maxTilt = 0.5

    // Pop up above final position (not current position, to prevent stacking on fast clicks)
    const popUpY = finalRoofY + floorHeight * 1.5
    const tiltX = MathUtils.clamp(this.roofAnim.tiltX + MathUtils.randFloatSpread(0.6), -maxTilt, maxTilt)
    const tiltY = MathUtils.clamp(this.roofAnim.tiltY + MathUtils.randFloatSpread(0.96), -maxTilt, maxTilt)
    const tiltZ = MathUtils.clamp(this.roofAnim.tiltZ + MathUtils.randFloatSpread(0.6), -maxTilt, maxTilt)

    const self = this
    const render = () => {
      self.roofDummy.position.set(center.x, self.roofAnim.y, center.y)
      self.roofDummy.scale.set(ex, 1, ez)
      self.roofDummy.rotation.set(self.roofAnim.tiltX, self.rotation + self.roofAnim.tiltY, self.roofAnim.tiltZ)
      self.roofDummy.updateMatrix()
      mesh.setMatrixAt(self.roofInstance, self.roofDummy.matrix)
    }

    // Render immediately at current position
    render()

    // Timeline: pop up, then bounce down
    const tl = gsap.timeline({
      onComplete: () => { self.roofAnimating = false; self.roofTween = null }
    })
    this.roofTween = tl

    tl.to(this.roofAnim, {
      y: popUpY, tiltX, tiltY, tiltZ,
      duration: 0.16,
      ease: 'power2.out',
      onUpdate: render
    })
    tl.to(this.roofAnim, {
      y: finalRoofY, tiltX: 0, tiltY: 0, tiltZ: 0,
      duration: 0.5,
      ease: 'bounce.out',
      onUpdate: render
    }, 0.18)

    // Play sound when roof lands
    tl.call(() => Sounds.play('stone', 1.0, 0.4, 0.4), null, 0.35)
  }

  /**
   * Animate deleting all floors except the base floor
   * Pop off roof, stagger-delete floors top-down, drop roof back
   */
  animateDelete(mesh, floorHeight, numFloors, onComplete) {
    this.settleFloors()
    this.settleRoof()

    const dummy = new Object3D()
    const center = this.box.getCenter(new Vector2())
    const size = this.box.getSize(new Vector2())
    const ex = this.tetro ? 1 : size.x
    const ez = this.tetro ? 1 : size.y

    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = this.tetro ? TetrominoGeometry.roofHalf : BlockGeometry.halfHeights[roofGeomIndex(this.typeTop)]

    // Current roof Y position (or calculate from numFloors)
    const currentRoofY = this.roofAnim.y > 0 ? this.roofAnim.y : numFloors * floorHeight + roofHalfHeight
    const finalRoofY = roofHalfHeight // At ground level (no floors)
    const popUpY = currentRoofY + floorHeight * 2 // Pop up high

    this.roofAnimating = true

    const self = this
    const renderRoof = () => {
      self.roofDummy.position.set(center.x, self.roofAnim.y, center.y)
      self.roofDummy.scale.set(ex, 1, ez)
      self.roofDummy.rotation.set(self.roofAnim.tiltX, self.rotation + self.roofAnim.tiltY, self.roofAnim.tiltZ)
      self.roofDummy.updateMatrix()
      mesh.setMatrixAt(self.roofInstance, self.roofDummy.matrix)
    }

    // Animation state for each floor (to be deleted - all floors including floor 0)
    const floorAnims = []
    for (let f = 0; f < numFloors; f++) {
      floorAnims.push({
        floorIdx: f,
        scale: 1,
        yOffset: 0,
        tiltX: 0, tiltY: 0, tiltZ: 0
      })
    }

    const tl = gsap.timeline({
      onComplete: () => {
        self.floorTween = null
        self.roofAnimating = false
        self.roofTween = null
        onComplete?.()
      }
    })
    this.floorTween = tl

    // Phase 1: Pop roof up with tilt
    const tiltX = MathUtils.randFloatSpread(0.4)
    const tiltY = MathUtils.randFloatSpread(0.6)
    const tiltZ = MathUtils.randFloatSpread(0.4)

    tl.to(this.roofAnim, {
      y: popUpY, tiltX, tiltY, tiltZ,
      duration: 0.15,
      ease: 'power2.out',
      onUpdate: renderRoof
    })

    // Phase 2: Stagger-delete floors from top to bottom
    const staggerDelay = 0.06
    for (let i = floorAnims.length - 1; i >= 0; i--) {
      const anim = floorAnims[i]
      const floorY = anim.floorIdx * floorHeight + floorHalfHeight
      const instanceIdx = this.floorInstances[anim.floorIdx]
      // Pitch decreases as floors go down (high pitch at top, low at bottom)
      const pitch = 0.8 + (anim.floorIdx / numFloors) * 1.2
      const updateFloor = () => {
        dummy.position.set(center.x, floorY + anim.yOffset, center.y)
        dummy.scale.set(ex * anim.scale, floorHeight * anim.scale, ez * anim.scale)
        dummy.rotation.set(anim.tiltX, this.rotation + anim.tiltY, anim.tiltZ)
        dummy.updateMatrix()
        mesh.setMatrixAt(instanceIdx, dummy.matrix)
      }

      // Shrink and fall with random tilt
      const delay = 0.15 + (floorAnims.length - 1 - i) * staggerDelay
      tl.to(anim, {
        scale: 0,
        yOffset: -floorHeight * 0.5,
        tiltX: MathUtils.randFloatSpread(0.3),
        tiltY: MathUtils.randFloatSpread(0.5),
        tiltZ: MathUtils.randFloatSpread(0.3),
        duration: 0.12,
        ease: 'power2.in',
        onUpdate: updateFloor,
        onComplete: () => {
          mesh.setVisibleAt(instanceIdx, false)
          Sounds.play('tick', pitch, 0.4, 1.0)
        }
      }, delay)
    }

    // Phase 3: Drop roof back down after floors are deleted
    const dropDelay = 0.15 + floorAnims.length * staggerDelay + 0.1
    tl.to(this.roofAnim, {
      y: finalRoofY, tiltX: 0, tiltY: 0, tiltZ: 0,
      duration: 0.4,
      ease: 'bounce.out',
      onUpdate: renderRoof
    }, dropDelay)

    // Play sound when roof lands
    const roofLandDelay = dropDelay + 0.2
    tl.call(() => Sounds.play('stone', 1.0, 0.4, 0.4), null, roofLandDelay)
  }

  /**
   * Handle click on tower - add a floor with animation and sounds
   * @param {City} city - The city instance (for towerMesh and gridToWorld)
   * @param {number} floorHeight - Height of each floor
   * @param {number} maxFloors - Maximum number of floors
   * @param {Debris} debris - Debris system for spawning particles
   * @param {Tower[]} allTowers - All towers for debris collision
   * @param {Function} onComplete - Called when animation completes
   */
  handleClick(city, floorHeight, maxFloors, debris, allTowers, onComplete, onBlockAdded) {
    const mesh = city.towerMesh
    const numFloors = this.numFloors

    // Check if we can add another floor
    if (numFloors >= maxFloors) {
      return
    }

    // Play tick sound and push down animation, then release
    Sounds.play('tick', 1.0, 0)

    const pushAmount = floorHeight * 0.25
    this.animateOffset(mesh, floorHeight, maxFloors, -pushAmount, 0.1, () => {
      // The press-down takes 100ms, and a creep can knock this tower over inside
      // it - or destroy it outright, in which case the tower goes back to the
      // pool and is handed straight out again as some other tile. Writing the
      // captured count into whatever now lives here gave it floors it never paid
      // for, and left a tetromino's roof being scaled as if it were a 1x1 - the
      // "wall suddenly enormous" bug. If anything moved underneath us, the click
      // is simply void.
      if (!this.visible || this.numFloors !== numFloors) return
      this.numFloors = numFloors + 1

      // Refresh ZOC radius / connectors immediately so they grow with the new
      // block right away, rather than waiting for the emerge animation to end.
      onBlockAdded?.()

      // Pitch increases with floor height (0.8 at ground, 2.0 at top)
      const pitch = 0.8 + (numFloors / maxFloors) * 1.2
      Sounds.play('pop', pitch, 0.15, 0.7)

      // Animate the tower back up with the new floor emerging
      this._animateNewFloorWithDebris(city, floorHeight, numFloors, debris, allTowers, onComplete)
    })
  }

  /**
   * Internal: Animate new floor with debris spawning
   */
  _animateNewFloorWithDebris(city, floorHeight, oldNumFloors, debris, allTowers, onComplete) {
    const mesh = city.towerMesh
    // Use lightened version of tower's base color for new floor and debris
    const baseColor = this.isLit && this.litColor ? this.litColor : this.baseColor
    const newFloorColor = Tower.lightenColor(baseColor)
    const debrisColor = newFloorColor.clone()
    const center = this.box.getCenter(new Vector2())
    const newFloorY = (oldNumFloors + 1) * floorHeight

    // Convert grid coords to world coords
    const world = city.gridToWorld(center.x, center.y)

    // Get tower size for debris spawn radius
    const size = this.box.getSize(new Vector2())
    const radius = Math.max(size.x, size.y) / 2

    // Callback to spawn debris when floor reaches max scale
    const onFloorPop = () => {
      // Tiny build bricks disabled for now (perf)
      // debris.setupNearbyCollisions(this, allTowers, floorHeight, city)
      // debris.spawn(world.x, newFloorY, world.z, radius, debrisColor)
    }

    this.animateNewFloor(mesh, floorHeight, oldNumFloors, newFloorColor, onComplete, onFloorPop)
  }
}
