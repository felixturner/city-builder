import { Box2, Color, Object3D, Vector2 } from 'three/webgpu'
import gsap from 'gsap'
import { BlockGeometry } from './lib/BlockGeometry.js'

/**
 * Tower class - represents a building/stack of blocks
 * Contains a top block (roof) and multiple base blocks (floors)
 */
export class Tower {
  static LIGHT_COLORS = [
    new Color(0xffffff),
    new Color(0xcccccc),
    new Color(0xaaaaaa),
    new Color(0x999999),
    new Color(0x086ff0),
  ]

  static DARK_COLORS = [
    new Color(0x666666),
    new Color(0x777777),
    new Color(0x888888),
    new Color(0x999999),
    new Color(0xbbbbbb),
  ]

  static ID = 0
  static LIGHT_BASE_COLOR = new Color(0x999999)
  static DARK_BASE_COLOR = new Color(0x666666)

  constructor() {
    this.id = Tower.ID++
    this.typeBottom = 0 // Base block geometry type
    this.typeTop = 0    // Top block geometry type
    this.box = new Box2()
    this.height = 1
    this.rotation = 0
    this.topColorIndex = 0
    this.topColor = Tower.DARK_COLORS[this.topColorIndex]
    this.baseColor = Tower.DARK_BASE_COLOR
    // For dynamic height recalculation
    this.cityNoiseVal = 0
    this.randFactor = 0
    this.skipFactor = 0 // For realtime visibility toggle
    this.colorIndex = 0 // Hover color index
    this.visible = true

    // Instance IDs for BatchedMesh
    this.floorInstances = [] // Base block instance IDs
    this.roofInstance = null // Top block instance ID

    // Animation state
    this.hoverTween = null
    this.floorTween = null
  }

  setTopColorIndex(index) {
    this.topColorIndex = index
    this.topColor = Tower.DARK_COLORS[this.topColorIndex]
  }

  /**
   * Get the number of floors based on height and floor height
   */
  getNumFloors(floorHeight) {
    return Math.max(1, Math.floor(this.height / floorHeight))
  }

  /**
   * Animate tower color to/from hover state using a single tween
   * @param {BatchedMesh} mesh - The batched mesh containing this tower's instances
   * @param {Color} targetColor - The target hover color, or null to restore original
   * @param {number} floorHeight - Height of each floor for calculating visible floors
   */
  animateHoverColor(mesh, targetColor, floorHeight) {
    // Kill any existing hover tween
    if (this.hoverTween) {
      this.hoverTween.kill()
    }

    const numFloors = this.getNumFloors(floorHeight)
    const floorInstances = this.floorInstances
    const roofInstance = this.roofInstance

    // Get current colors from first floor and roof
    const currentFloorColor = new Color()
    const currentRoofColor = new Color()
    mesh.getColorAt(floorInstances[0], currentFloorColor)
    mesh.getColorAt(roofInstance, currentRoofColor)

    // Target colors
    const toFloorColor = targetColor || this.baseColor
    const toRoofColor = targetColor || this.topColor

    // Interpolation colors
    const floorColor = currentFloorColor.clone()
    const roofColor = currentRoofColor.clone()

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

        // Apply to all visible floors
        for (let f = 0; f < numFloors; f++) {
          mesh.setColorAt(floorInstances[f], floorColor)
        }
        // Apply to roof
        mesh.setColorAt(roofInstance, roofColor)
      }
    })
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
    const numFloors = Math.max(1, Math.floor(this.height / floorHeight))

    // Half-heights for centered geometries
    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = BlockGeometry.halfHeights[this.typeTop]

    // Animate all floor instances
    const anim = { offset: 0 }
    gsap.to(anim, {
      offset: offset,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        for (let f = 0; f < numFloors; f++) {
          const idx = this.floorInstances[f]
          dummy.position.set(center.x, f * floorHeight + floorHalfHeight + anim.offset, center.y)
          dummy.scale.set(size.x, floorHeight, size.y)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(idx, dummy.matrix)
        }
        // Roof follows
        dummy.position.set(center.x, numFloors * floorHeight + roofHalfHeight + anim.offset, center.y)
        dummy.scale.set(size.x, 1, size.y)
        dummy.rotation.set(0, this.rotation, 0)
        dummy.updateMatrix()
        mesh.setMatrixAt(this.roofInstance, dummy.matrix)
      },
      onComplete: onComplete
    })
  }

  /**
   * Animate adding a new floor with roof pop-off effect
   * @param {BatchedMesh} mesh - The batched mesh
   * @param {number} floorHeight - Height of each floor
   * @param {number} oldNumFloors - Number of floors before adding
   * @param {Color} hoverColor - Color to apply to new floor
   * @param {Function} onComplete - Callback when animation completes
   */
  animateNewFloor(mesh, floorHeight, oldNumFloors, hoverColor, onComplete) {
    // Use local dummy to avoid conflicts with other animations
    const dummy = new Object3D()
    const center = this.box.getCenter(new Vector2())
    const size = this.box.getSize(new Vector2())
    const newNumFloors = oldNumFloors + 1

    // If animation is running, fast-forward to end
    if (this.floorTween && this.floorTween.isActive()) {
      this.floorTween.progress(1)
    }

    // Reset dummy rotation to avoid stale state
    dummy.rotation.set(0, 0, 0)

    // Get the next unused floor instance for the new floor
    const newFloorIdx = this.floorInstances[oldNumFloors]

    // Set the new floor to hover color (but keep hidden initially)
    mesh.setColorAt(newFloorIdx, hoverColor)

    // Random tilt for roof pop-off (max: X/Z ±0.3, Y ±0.48)
    const tiltX = (Math.random() - 0.5) * 0.6
    const tiltY = (Math.random() - 0.5) * 0.96 // 60% of 1.6
    const tiltZ = (Math.random() - 0.5) * 0.6

    // Half-heights for centered geometries
    const floorHalfHeight = floorHeight / 2
    const roofHalfHeight = BlockGeometry.halfHeights[this.typeTop]

    // Position where new floor will be placed (on top of existing floors)
    const newFloorY = oldNumFloors * floorHeight + floorHalfHeight
    // Final roof position (center of roof)
    const finalRoofY = newNumFloors * floorHeight + roofHalfHeight
    // Current roof position
    const currentRoofY = oldNumFloors * floorHeight + roofHalfHeight

    // Random tilt for new floor pop (max: X/Z ±0.1, Y ±0.2)
    const floorTiltX = (Math.random() - 0.5) * 0.2
    const floorTiltY = (Math.random() - 0.5) * 0.4
    const floorTiltZ = (Math.random() - 0.5) * 0.2

    // Tower Y offset on mouse up
    const towerYOffset = floorHeight * 0.2

    // Animation state
    const anim = {
      // Roof pop-off - starts at offset position
      roofY: currentRoofY + towerYOffset,
      roofTiltX: 0,
      roofTiltY: 0,
      roofTiltZ: 0,
      // New floor scale (starts small, scales from center)
      newFloorScale: 0.1,
      // Y bounce offset (starts at 0, pops up then settles)
      newFloorYOffset: 0,
      // New floor tilt (pops up with tilt, settles to 0)
      newFloorTiltX: 0,
      newFloorTiltY: 0,
      newFloorTiltZ: 0,
      // Base offset - immediately set to slight offset up (not from pressed state)
      baseOffset: towerYOffset
    }

    // Create timeline for sequenced animation
    const tl = gsap.timeline({
      onComplete: () => {
        this.floorTween = null
        if (onComplete) onComplete()
      }
    })
    this.floorTween = tl
    tl.timeScale(0.5)

    // ===== TIMELINE (absolute times) =====
    // 0.00 - 0.12: Tower settles down from offset (power2.out)
    // 0.00 - 0.08: Roof flies off with tilt (power2.out) - starts immediately!
    // 0.00 - 0.1: New floor scales in (bounce.out)
    // 0.00 - 0.1: New floor Y pops up (power2.out)
    // 0.09 - 0.34: Roof falls back down (bounce.out)
    // 0.11 - 0.18: New floor Y bounces down (bounce.out)

    // [0.00 - 0.12] Phase 1: Tower settles down from slight offset (power2.out)
    tl.to(anim, {
      baseOffset: 0,
      duration: 0.12,
      ease: 'power2.out',
      onUpdate: () => {
        // Update existing floors only (roof handled by Phase 2)
        for (let f = 0; f < oldNumFloors; f++) {
          const idx = this.floorInstances[f]
          dummy.position.set(center.x, f * floorHeight + floorHalfHeight + anim.baseOffset, center.y)
          dummy.scale.set(size.x, floorHeight, size.y)
          dummy.rotation.set(0, this.rotation, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(idx, dummy.matrix)
        }
      }
    }, 0)

    // [0.00 - 0.08] Phase 2: Roof flies off immediately with tilt (starts at offset position)
    tl.to(anim, {
      roofY: finalRoofY + floorHeight * 2.0,
      roofTiltX: tiltX,
      roofTiltY: tiltY,
      roofTiltZ: tiltZ,
      duration: 0.08,
      ease: 'power2.out',
      onUpdate: () => {
        dummy.position.set(center.x, anim.roofY, center.y)
        dummy.scale.set(size.x, 1, size.y)
        dummy.rotation.set(anim.roofTiltX, this.rotation + anim.roofTiltY, anim.roofTiltZ)
        dummy.updateMatrix()
        mesh.setMatrixAt(this.roofInstance, dummy.matrix)
      }
    }, 0)

    // [0.00 - 0.10] New floor scales in (XYZ from center)
    tl.to(anim, {
      newFloorScale: 1,
      duration: 0.1,
      ease: 'bounce.out',
      onStart: () => {
        mesh.setVisibleAt(newFloorIdx, true)
      },
      onUpdate: () => {
        dummy.position.set(center.x, newFloorY + anim.newFloorYOffset, center.y)
        dummy.scale.set(size.x * anim.newFloorScale, floorHeight * anim.newFloorScale, size.y * anim.newFloorScale)
        dummy.rotation.set(anim.newFloorTiltX, this.rotation + anim.newFloorTiltY, anim.newFloorTiltZ)
        dummy.updateMatrix()
        mesh.setMatrixAt(newFloorIdx, dummy.matrix)
      },
      onComplete: () => {
        this.floorInstances[oldNumFloors] = newFloorIdx
      }
    }, 0)

    // [0.09 - 0.34] Roof falls with bounce
    tl.to(anim, {
      roofY: finalRoofY,
      roofTiltX: 0,
      roofTiltY: 0,
      roofTiltZ: 0,
      duration: 0.25,
      ease: 'bounce.out',
      onUpdate: () => {
        dummy.position.set(center.x, anim.roofY, center.y)
        dummy.scale.set(size.x, 1, size.y)
        dummy.rotation.set(anim.roofTiltX, this.rotation + anim.roofTiltY, anim.roofTiltZ)
        dummy.updateMatrix()
        mesh.setMatrixAt(this.roofInstance, dummy.matrix)
      }
    }, 0.09)

    // [0.00 - 0.10] New floor Y pops up with tilt
    tl.to(anim, {
      newFloorYOffset: floorHeight * 0.3,
      newFloorTiltX: floorTiltX,
      newFloorTiltY: floorTiltY,
      newFloorTiltZ: floorTiltZ,
      duration: 0.1,
      ease: 'power2.out'
    }, 0)

    // [0.11 - 0.18] New floor Y bounces down, tilt settles
    tl.to(anim, {
      newFloorYOffset: 0,
      newFloorTiltX: 0,
      newFloorTiltY: 0,
      newFloorTiltZ: 0,
      duration: 0.07,
      ease: 'bounce.out',
      onUpdate: () => {
        dummy.position.set(center.x, newFloorY + anim.newFloorYOffset, center.y)
        dummy.scale.set(size.x * anim.newFloorScale, floorHeight * anim.newFloorScale, size.y * anim.newFloorScale)
        dummy.rotation.set(anim.newFloorTiltX, this.rotation + anim.newFloorTiltY, anim.newFloorTiltZ)
        dummy.updateMatrix()
        mesh.setMatrixAt(newFloorIdx, dummy.matrix)
      }
    }, 0.11)
  }
}
