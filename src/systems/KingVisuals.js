import {
  Mesh, BoxGeometry, CylinderGeometry, RingGeometry, CircleGeometry, Color, DoubleSide,
  MeshBasicNodeMaterial, MeshStandardNodeMaterial,
} from 'three/webgpu'
import { positionLocal, smoothstep } from 'three/tsl'
import gsap from 'gsap'
import { Sounds } from '../lib/Sounds.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { Tower } from '../Tower.js'
import { fxMaterial, glow, stutter, NO_AO_MRT } from '../fx.js'
import { PINK, WHITE } from '../palette.js'
import { towerTopY, roofGeomIndex, KING_WARN_CELLS, KING_WARN_FLOORS } from '../blockTypes.js'

/** Accent index the king always wears: 0 is pink, its own colour. */
export const KING_COLOR = 0
const KING_MARKER_SIZE = 1.04 // world units across, before the corner-up tilt
const KING_MARKER_HOVER = 1.4 // rest height above the king's roof
// Sim seconds between the beam striking in and the king's first energy. Long
// enough to read as cause and effect rather than coincidence.
const KING_EARN_DELAY = 1.0
// Seconds for a damage flash to fade back. The king holds its flash longer than
// an ordinary tower - its hits are the ones you have to notice from the far side
// of the board.
export const KING_HIT_FLASH = 0.45
// Times the low-health siren sounds before it gives up. A warning that never
// stops is just the music: you have heard it, and you either can do something
// about the king or you cannot. It re-arms if the king is built back out of
// range and driven down again.
const KING_ALARM_PLAYS = 5
// Line width shared by the king's two markers - the ground ring and the beam
// standing on the tile - so they read as one thing rather than two.
const KING_MARK_WIDTH = 0.16

/**
 * Everything that says WHERE THE KING IS: the beam standing on it, the ring
 * burned into the ground around it, the cube hovering above it, the low-health
 * siren and the shockwave when it dies.
 *
 * Split out of City because none of it is the city. It is one subsystem with its
 * own state - three meshes and a handful of animation latches - that City was
 * carrying inline among grid maths and tower pooling, and it was the largest
 * thing in that file that nothing else touched.
 *
 * The king's STATE stays on City (`king`, `kingAlive`, `kingMaxFloors`,
 * `kingEarning`), because half the game reads it. This owns only the picture.
 */
export class KingVisuals {
  constructor(city) {
    this.city = city
    this.kingBeam = null
    this.kingRing = null
    this.kingMarker = null
    this.kingBeamHeight = 0
    this._kingShown = false      // beam has struck in for this appearance
    this._kingFlicker = false    // ...and is mid-stutter, so it owns visibility
    this._kingAlarmFired = false // the low-health siren has played this time
    this._markerT = 0            // marker bob phase, advanced on sim time
    this._markerFloors = -1      // height the marker's colour was last matched to
    this._pulseColor = new Color()
  }

  /** World Y of the middle of the hovering cube - where the king's energy
   *  leaves from. Falls back to the roof before the marker exists. */
  get markerY() {
    if (this.kingMarker) return this.kingMarker.position.y
    const king = this.city.king
    return king ? towerTopY(king, this.city.floorHeight) + 0.5 : 0
  }

  /**
   * A shaft of light standing on the king and running straight up out of the
   * board, in whatever accent the king drew this run.
   *
   * The king is a single 1x1 tile in the middle of a city that fills the screen,
   * and once walls go up around it there is nothing to say where it is. The beam
   * is readable from any camera angle and at any zoom, which a marker on the
   * ground is not.
   *
   * Additive and AO-free like every other coloured effect (see fx.js), and depth
   * tested, so towers in front of it occlude it rather than it hanging over the
   * whole city.
   */
  createKingBeam() {
    if (!this.city.king) return
    const H = 160 // tall enough to leave frame at every zoom level
    // Open-ended: the caps would read as bright discs from a high camera.
    // Radius matches the ring's 0.16 width, and the colour matches it too: the
    // beam and the ring are one marker seen from two angles, and they were a
    // different yellow and twice the thickness apart.
    const geo = new CylinderGeometry(KING_MARK_WIDTH / 2, KING_MARK_WIDTH / 2, H, 12, 1, true)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: new Color(PINK),
      side: DoubleSide, // an open tube shows its inside wall from most angles
    }))
    // Solid where it leaves the roof, gone by the top - a hard cut in the sky
    // would read as a cylinder rather than a beam. positionLocal.y runs
    // -H/2..H/2, so this is just that remapped and flipped.
    const tY = positionLocal.y.div(H).add(0.5)
    mat.opacityNode = smoothstep(1.0, 0.0, tY).mul(0.55)
    const mesh = glow(new Mesh(geo, mat))
    mesh.frustumCulled = false // it is taller than its own bounding sphere suggests
    mesh.renderOrder = 4
    this.city.scene.add(mesh)
    this.kingBeam = mesh
    this.kingBeamHeight = H
    this.updateKingBeam()
  }

  /** Keep the beam standing on the king's roof as the king loses floors. */
  updateKingBeam() {
    const beam = this.kingBeam
    if (!beam) return
    const king = this.city.king
    // Held back until the opening build-up finishes: the beam is a marker for a
    // city that exists, and firing it up while the towers are still rising drew
    // the eye away from the one animation that only plays once.
    if (!king || !king.visible || !this.city.kingAlive || !this.city.introBuilt) {
      beam.visible = false
      if (this.kingRing) this.kingRing.visible = false
      this._kingShown = false
      this.city.kingEarning = false
      return
    }
    // First frame it is allowed to show: kick it in rather than having it appear
    // between one frame and the next.
    if (!this._kingShown) {
      this._kingShown = true
      this.flickerKingBeam()
      // The king starts earning a beat AFTER it lights up, so the first energy
      // is visibly a consequence of the king coming on rather than something
      // that happened to arrive at the same moment.
      this.city.kingEarning = false
      this.city.demo?.after(KING_EARN_DELAY, () => { this.city.kingEarning = true })
    }
    // While the flicker is running it owns visibility - this would otherwise
    // switch the beam back on between the timeline's own frames.
    if (!this._kingFlicker) beam.visible = true
    const c = king.box.getCenter(this.city.towerCenter)
    // Rooted at ground level rather than on the roof, so it reads as coming out
    // of the tower rather than hovering above it - and it no longer bobs up and
    // down as the king loses and regains floors.
    beam.position.set(
      c.x + this.city.gridOffsetX,
      this.kingBeamHeight / 2,
      c.y + this.city.gridOffsetZ
    )
    // The danger ring shares the beam's fate: same king, same visibility rules,
    // and the board can grow underneath both of them.
    if (this.kingRing) {
      if (!this._kingFlicker) this.kingRing.visible = true
      this.kingRing.position.set(c.x + this.city.gridOffsetX, 0.04, c.y + this.city.gridOffsetZ)
    }
  }

  /**
   * Strike the king's beam and danger ring in like a tube light coming on.
   *
   * The beam is the one thing on the board that says "this is what you are
   * defending", and it used to simply be there the frame the intro finished.
   * A few stutters and a chime make it an event you look at - and it lights the
   * ring at the same time, so the two read as one thing switching on.
   */
  flickerKingBeam() {
    const parts = [this.kingBeam, this.kingRing].filter(Boolean)
    if (!parts.length) return
    this._kingFlicker = true
    Sounds.play('good')
    stutter(gsap, parts, { onComplete: () => { this._kingFlicker = false } })
  }

  /**
   * The king's danger zone, drawn as a thin yellow ring on the ground.
   *
   * The proximity siren fires when a creep is within KING_WARN_CELLS of the
   * king, and until now that line was audible only - you heard that something
   * had got close without being able to see where "close" started. Same radius,
   * same constant, so the ring is the sound made visible.
   */
  createKingRing() {
    if (!this.city.king) return
    const r = KING_WARN_CELLS * this.city.cellUnit
    const geo = new RingGeometry(r - KING_MARK_WIDTH / 2, r + KING_MARK_WIDTH / 2, 96)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: new Color(PINK), opacity: 0.75,
    }))
    const mesh = glow(new Mesh(geo, mat))
    mesh.rotation.x = -Math.PI / 2 // RingGeometry lives in XY; lie it flat
    mesh.renderOrder = -1 // under the turret/shield rings, like the other ground art
    this.city.scene.add(mesh)
    this.kingRing = mesh
  }

  /** A big yellow shockwave washing out across the floor from the dead king -
   *  the whole board learns the moment it dies, not just that corner of it. */
  kingDeathPulse() {
    const king = this.city.king
    if (!king) return
    const c = king.box.getCenter(this.city.towerCenter)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: this.city.accentColors[KING_COLOR].clone(),
      opacity: 0.45,
    }))
    const disc = glow(new Mesh(new CircleGeometry(1, 64), mat))
    disc.rotation.x = -Math.PI / 2
    disc.position.set(c.x + this.city.gridOffsetX, 0.15, c.y + this.city.gridOffsetZ)
    disc.renderOrder = 6
    this.city.scene.add(disc)
    const r = this.city.visibleHalf // fully transparent right at the current map edge
    // Scale and fade share a duration AND an ease, so the disc's growth and its
    // disappearance are one motion. On different eases the expo scale was done
    // in the first third of a second while the power2 fade was still going, and
    // what you saw was a full-size disc sitting there apparently not fading.
    gsap.to(disc.scale, { x: r, y: r, duration: 2.0, ease: 'expo.out' })
    gsap.to(mat, {
      opacity: 0, duration: 2.0, ease: 'expo.out',
      onComplete: () => {
        this.city.scene.remove(disc)
        disc.geometry.dispose()
        mat.dispose()
      },
    })
  }

  /** Kick the king's (longer) damage flash to full. */
  flashKing() { this.city.flashTower(this.city.king, KING_HIT_FLASH) }


  /**
   * The visual half of the exposed-king warning: pulse the king's blocks toward
   * a bright glow. `p` is 0..1 (Creeps drives it with a sine); colours >1 push
   * past the palette so the peak genuinely glows. Creeps restores the true
   * colours (renderer.applyTypeVisuals) when the warning ends.
   */
  pulseKingColor(p) {
    const king = this.city.king
    if (!king || !king.visible) return
    if (!this._pulseColor) this._pulseColor = new Color()
    this._pulseColor.copy(king.baseColor).lerp(WHITE, 0.6 * p).multiplyScalar(1 + p * 0.9)
    this.city.setTowerColor(king, this._pulseColor)
  }

  /**
   * The king's low-health siren: KING_ALARM_PLAYS times, then quiet.
   *
   * It used to fire once on the crossing into the last two floors, which said
   * "this just happened" about a condition that then sat there for the rest of
   * the round. It now starts when the king drops to KING_WARN_FLOORS and repeats
   * a few times before giving up - long enough to be unmissable, short of
   * becoming the soundtrack.
   *
   * The latch is what keeps it from restarting the moment the run of plays ends:
   * it re-arms only when the king climbs back out of range, so a king built up
   * and knocked down again gets a fresh alarm. Being built back up also cuts the
   * siren mid-run, and dying fades it out under the sting (triggerGameOver).
   */
  updateKingAlarm() {
    const king = this.city.king
    // introBUILT, not introDone: the intro empties every tower to zero floors and
    // rebuilds them, and the camera lands well before the king is back up. Armed
    // on the camera landing, this siren fired every single game - the king was
    // genuinely on one floor at the time, it just had not been knocked there.
    const low = !!king && king.visible && this.city.kingAlive && this.city.introBuilt
      && king.numFloors <= KING_WARN_FLOORS
    if (!low) {
      this._kingAlarmFired = false
      Sounds.stop('king-warning')
      return
    }
    if (this._kingAlarmFired) return
    this._kingAlarmFired = true
    Sounds.loop('king-warning', 0.45, 1.0, KING_ALARM_PLAYS)
  }

  /**
   * A cube standing on its corner, hovering and spinning over the king.
   *
   * The king is a one-cell tile in the middle of a board that fills the screen,
   * and once walls go up around it there is nothing at eye level to say which
   * tile it is - the beam reads from far away, but not up close, and the tile
   * itself is the same yellow as barracks and shields. This is the near marker:
   * the same corner-up spin the loot crates wore before they became stars, so
   * the shape already reads as "the thing that matters here".
   */
  createKingMarker() {
    if (!this.city.king) return
    const geo = new BoxGeometry(KING_MARKER_SIZE, KING_MARKER_SIZE, KING_MARKER_SIZE)
    // No emissive and NOT on the glow layer: it sits right over the king, and a
    // bloomed marker smeared over the tile it is meant to point at.
    const mat = new MeshStandardNodeMaterial({
      // Matched to the king's ROOF, not its base accent. The stack is shaded by
      // floor and the roof takes the shade of the block under it, so the flat
      // accent came out the colour of the king's ground floor - the marker read
      // as a chip off the bottom of the tower rather than a thing sitting on top
      // of it. Re-derived whenever the king's height changes (updateKingMarker).
      color: new Color(),
      roughness: 0.35,
      metalness: 0.1,
    })
    mat.mrtNode = NO_AO_MRT()
    const mesh = new Mesh(geo, mat)
    // 45deg about Z stands it on an EDGE, then atan(1/sqrt2) about X tips that
    // edge onto a POINT. YXZ order so both tilts land before the Y spin, which
    // then turns it about world up instead of tumbling it.
    mesh.rotation.order = 'YXZ'
    mesh.rotation.set(-Math.atan(1 / Math.SQRT2), 0, Math.PI / 4)
    mesh.castShadow = true
    this.city.scene.add(mesh)
    this.kingMarker = mesh
    this.refreshKingMarkerColor()
  }

  /** Take the marker's colour from the king's roof block, whatever height it is. */
  refreshKingMarkerColor() {
    const king = this.city.king
    if (!this.kingMarker || !king) return
    Tower.roofShade(king, king.topColor || king.baseColor, this.kingMarker.material.color)
  }

  /**
   * Hover, bob and spin the marker; parks it on the king's current roof.
   *
   * It rides the roof's ANIMATED height while the roof is in flight, not the
   * height its floor count implies. The two are different during a build: the
   * floor count goes up the instant a block is added, while the roof mesh tweens
   * to its new position over the next fraction of a second - so the marker
   * teleported a storey and waited there for the roof to catch up.
   *
   * The roof is one instance of a BatchedMesh, not an Object3D, so the marker
   * cannot be parented to it. Reading `roofAnim.y` - the same value the roof
   * tween writes each frame - is as close as this gets, and it costs nothing.
   */
  updateKingMarker(dt) {
    const marker = this.kingMarker
    if (!marker) return
    const king = this.city.king
    if (!king || !king.visible || !this.city.kingAlive) { marker.visible = false; return }
    marker.visible = true
    this._markerT = (this._markerT || 0) + dt
    const c = king.box.getCenter(this.city.towerCenter)
    const roofHalf = BlockGeometry.halfHeights[roofGeomIndex(king.typeTop)]
    const top = king.roofAnimating && king.roofAnim.y > 0
      ? king.roofAnim.y + roofHalf
      : towerTopY(king, this.city.floorHeight)
    marker.position.set(
      c.x + this.city.gridOffsetX,
      top + KING_MARKER_HOVER + Math.sin(this._markerT * 1.6) * 0.22,
      c.y + this.city.gridOffsetZ
    )
    marker.rotation.y += 0.9 * dt
    // The roof's shade depends on the floor count, so it moves as the king is
    // built up or knocked down.
    if (this._markerFloors !== king.numFloors) {
      this._markerFloors = king.numFloors
      this.refreshKingMarkerColor()
    }
  }

  /** Build the three markers. Called once the king is placed. */
  create() {
    this.createKingBeam()
    this.createKingRing()
    this.createKingMarker()
  }

  /** Hide everything - the board is being cleared. */
  hide() {
    if (this.kingMarker) this.kingMarker.visible = false
    if (this.kingBeam) this.kingBeam.visible = false
    if (this.kingRing) this.kingRing.visible = false
  }

  /** One call from City.update, so the order these run in lives in one place. */
  update(dt) {
    this.updateKingAlarm()
    this.updateKingMarker(dt)
    this.updateKingBeam()
  }
}
