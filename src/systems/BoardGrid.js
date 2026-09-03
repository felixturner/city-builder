import { Mesh, PlaneGeometry, GridHelper, MeshBasicNodeMaterial, Line2NodeMaterial, Vector2 } from 'three/webgpu'
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { uniform, uv, fract, step, min, float, vec3, mrt } from 'three/tsl'
import gsap from 'gsap'
import { CITY } from '../palette.js'

/** Seconds the ground takes to ease outward when a ring opens. Demo paces the
 *  boss-reward beat against this. */
export const EXPAND_TIME = 1.2
// The grid flashing in behind the rect once it lands, and how far past its
// resting weight that flash peaks.
const GRID_FLASH_TIME = 0.5
const GRID_FLASH_GAIN = 1.9
// Resting opacities of the board furniture, so the flash knows where to settle.
const CELL_GRID_OPACITY = 0.5
const LOT_GRID_OPACITY = 0.85
// The board outline: white, over ground that steps down in value outside it
// (see Lighting's three ground planes).
const OUTLINE_COLOR = CITY.outline
const OUTLINE_OPACITY = 0.55

/**
 * The board's furniture: the fine cell grid, the coarse lot grid, the dot mesh
 * over them and the white outline marking where the play area ends.
 *
 * All presentation. None of it decides anything - what is walkable, what is
 * occupied and where a cell is in the world all live on City - and none of it
 * is read outside this file except to be shown or hidden.
 *
 * It is here because it moves as one thing. Opening a ring has to grow the
 * outline, rebuild both grids at the new size, flash them in behind the rect
 * and dispose the old meshes only once the tween that is still drawing them has
 * finished; that sequence was spread across four methods in a 1900-line file.
 */
export class BoardGrid {
  constructor(city) {
    this.city = city
    this.cellGrid = null
    this.lotGrid = null
    this.dotMesh = null
    this.boardOutline = null
    // Drives the dots' alpha, so they can fade with the grid lines they sit on.
    this.gridFade = uniform(1)
    this._expandTween = null
    this._expanding = false
    this._staleGrids = null // old meshes held until the expand tween lands
  }

  /**
   * The board opening up, as a two-beat animation instead of a redraw.
   *
   * 1. The outline rect tweens from the old bounds out to the new ones, over the
   *    ground easing outward under it. The OLD grid is held on screen for the
   *    whole trip - redrawing it up front left the board bare while the rect
   *    travelled, which reads as a glitch rather than as ground being won.
   * 2. The rect lands, the stale grid goes, and the new one flashes in behind
   *    it: blank, a bright overshoot, then its resting weight.
   *
   * Sequenced rather than simultaneous because the rect is the readable part -
   * it is the thing that says how much you gained - and a grid redrawing on the
   * same frame buries it. Demo paces the boss beat (quiet, grow, cards) against
   * EXPAND_TIME, and the flash lands inside the CARD_DELAY that follows.
   */
  expandGrids(prevHalf) {
    const half = this.city.visibleHalf
    // Detach (don't dispose) the old grid so createGrids builds a fresh set
    // alongside it. The rect is the one piece replaced immediately, because it
    // is the piece that animates.
    const stale = [this.cellGrid, this.dotMesh, this.lotGrid].filter(Boolean)
    this.cellGrid = null
    this.dotMesh = null
    this.lotGrid = null
    this.disposeGridObject(this.boardOutline)
    this.boardOutline = null

    // createGrids sets the ground to its new size instantly. growPlayArea has
    // already started it easing there, and gsap reads a tween's start value on
    // its first tick - which happens AFTER this - so letting the snap through
    // would hand the tween a start equal to its target and the ground would
    // simply jump. Suppressed for the duration of the rebuild.
    this._expanding = true
    this.createGrids()
    this._expanding = false
    this.setGridFade(0) // new grid drawn but blank until the rect lands

    const line = this.boardOutline
    const from = half > 0 ? prevHalf / half : 1
    line.scale.set(from, 1, from)
    // A second expand landing mid-tween would orphan the grid the first one was
    // still holding on screen, so anything pending is dropped here.
    this._expandTween?.kill()
    for (const obj of this._staleGrids || []) this.disposeGridObject(obj)
    this._staleGrids = stale
    this._expandTween = gsap.to(line.scale, {
      x: 1, z: 1, duration: EXPAND_TIME, ease: 'power2.out',
      onComplete: () => {
        for (const obj of this._staleGrids) this.disposeGridObject(obj)
        this._staleGrids = null
        this.flashGrid()
      },
    })
  }

  /** Set the whole grid's visible weight, 0 = blank, 1 = resting. */
  setGridFade(f) {
    if (this.cellGrid) this.cellGrid.material.opacity = CELL_GRID_OPACITY * f
    if (this.lotGrid) this.lotGrid.material.opacity = LOT_GRID_OPACITY * f
    if (this.gridFade) this.gridFade.value = f
  }

  /**
   * Flash the new grid in: up past its resting weight, then back down to it.
   *
   * GridHelper bakes its colour into vertex colours, so brightness here can only
   * be opacity - which is why the resting weights are held below 1 (see
   * LOT_GRID_OPACITY): a line already at full alpha has nowhere to flash to.
   * The dots go through a uniform instead, and being alpha-tested they pop in
   * partway up the ramp rather than fading, which suits the beat.
   */
  flashGrid() {
    const up = GRID_FLASH_TIME * 0.35, down = GRID_FLASH_TIME * 0.65
    const ramp = (target, key, peak, rest) => {
      gsap.timeline()
        .to(target, { [key]: peak, duration: up, ease: 'power2.out' })
        .to(target, { [key]: rest, duration: down, ease: 'power2.inOut' })
    }
    if (this.cellGrid) ramp(this.cellGrid.material, 'opacity', 1, CELL_GRID_OPACITY)
    if (this.lotGrid) ramp(this.lotGrid.material, 'opacity', 1, LOT_GRID_OPACITY)
    if (this.gridFade) ramp(this.gridFade, 'value', GRID_FLASH_GAIN, 1)
    // The rect pulses with it rather than from zero - it has been on screen for
    // the whole tween and blinking it out would undo the move it just made.
    if (this.boardOutline) ramp(this.boardOutline.material, 'opacity', 1, OUTLINE_OPACITY)
  }

  /**
   * Create debug grid helpers aligned with the city
   */
  /**
   * A 2px outline round the buildable area.
   *
   * Line2 rather than a LineLoop or a thin quad: WebGPU (like WebGL) ignores
   * linewidth on ordinary lines, so a plain line is always 1px, and a
   * world-space quad border would grow and shrink with zoom. Line2NodeMaterial
   * with worldUnits:false measures the width in screen pixels, so the outline
   * stays 2px whether you're zoomed all the way in or out.
   */
  createBoardOutline() {
    const hw = this.city.visibleHalf, hh = this.city.visibleHalf
    const y = 0.02
    const geom = new LineGeometry()
    geom.setPositions([
      -hw, y, -hh,
      hw, y, -hh,
      hw, y, hh,
      -hw, y, hh,
      -hw, y, -hh, // closed
    ])
    const mat = new Line2NodeMaterial({
      color: OUTLINE_COLOR,
      linewidth: 2, // screen pixels, because worldUnits is false
      worldUnits: false,
      transparent: true,
      opacity: OUTLINE_OPACITY,
      depthWrite: false,
    })
    // Line2 needs the viewport to convert pixel width into clip space.
    mat.resolution = new Vector2(window.innerWidth, window.innerHeight)
    const line = new Line2(geom, mat)
    line.computeLineDistances()
    line.renderOrder = 4
    line.frustumCulled = false
    this.city.scene.add(line)
    this.boardOutline = line
  }

  /**
   * Tear down the board's grid furniture and draw it again at the current size.
   *
   * Rebuilt rather than rescaled because the dot shader bakes the cell count
   * into its UV multiply and GridHelper bakes its divisions into geometry -
   * scaling either one would stretch the cells instead of adding more.
   */
  rebuildGrids() {
    for (const key of ['boardOutline', 'cellGrid', 'dotMesh', 'lotGrid']) {
      this.disposeGridObject(this[key])
      this[key] = null
    }
    this.createGrids()
  }

  /** Pull one piece of grid furniture out of the scene and free it. */
  disposeGridObject(obj) {
    if (!obj) return
    this.city.scene.remove(obj)
    obj.geometry?.dispose()
    obj.material?.dispose()
  }

  createGrids() {
    // Snap the ground to the new size - except mid-expand, where it is already
    // being tweened there (see expandGrids).
    if (!this._expanding) this.city.lighting?.setBoardSize(this.city.visibleHalf, this.city.cellSize)
    this.createBoardOutline()
    // One dial the expand flash drives the dots with (see flashGrid). Rebuilt
    // with the grid, because the material it feeds is rebuilt with it too.
    this.gridFade = uniform(1)
    const span = this.city.visibleHalf * 2
    // The cell grid runs PAST the bounds, out over the field the creeps walk in
    // across (the same one lot of margin the ground under it covers - see
    // Lighting.setBoardSize). The board ends where the white outline is; the grid
    // carrying on past it says the ground out there is real, which is where you
    // watch a wave form up.
    const gridSpan = span + this.city.cellSize * 2
    const cellGrid = new GridHelper(gridSpan, gridSpan / this.city.cellUnit, CITY.grid, CITY.grid)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = CELL_GRID_OPACITY
    cellGrid.position.set(0, 0.01, 0)
    this.city.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(gridSpan, gridSpan)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections (one per buildable cell, matching cell grid)
    const cellCoord = uv().mul(gridSpan / this.city.cellUnit)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    // Colour rides the fade as well as alpha: the dots are alpha-TESTED, so
    // opacity alone would only pop them in at the halfway point and the flash's
    // overshoot would do nothing to them. Brightness makes them part of it.
    const dotLit = dotColor.mul(this.gridFade)
    dotMaterial.colorNode = dotLit
    dotMaterial.opacityNode = dotMask.mul(this.gridFade)
    dotMaterial.mrtNode = mrt({
      output: dotLit,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.city.scene.add(this.dotMesh)

    // Coarse lot grid - centered at origin, lines at lot spacing intervals.
    // Held just under full alpha so the expand flash has somewhere to go.
    const lotGrid = new GridHelper(span, this.city.visibleLots, CITY.grid, CITY.grid)
    lotGrid.material.transparent = true
    lotGrid.material.opacity = LOT_GRID_OPACITY
    lotGrid.position.set(0, 0.02, 0)
    this.city.scene.add(lotGrid)
    this.lotGrid = lotGrid

    this.city.lotGrowth.createLotOutlines()
    this.city.enclosure.build()
  }

  /** Line2 needs pixel dimensions to keep a constant on-screen width. */
  onResize(w, h) {
    if (this.boardOutline) this.boardOutline.material.resolution.set(w, h)
  }
}
