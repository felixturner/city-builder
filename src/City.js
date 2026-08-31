import {
  Line2NodeMaterial,
  MathUtils,
  Vector2,
  Vector3,
  Object3D,
  BatchedMesh,
  CylinderGeometry,
  DoubleSide,
  MeshPhysicalNodeMaterial,
  Color,
  GridHelper,
  PlaneGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  ArrowHelper,
  CircleGeometry,
  Group,
} from 'three/webgpu'
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import gsap from 'gsap'
import { uniform, cos, sin, vec3, normalWorld, positionViewDirection, cameraViewMatrix, roughness, pmremTexture, mrt, uv, fract, step, min, float, output, positionLocal, smoothstep } from 'three/tsl'
import { Tower } from './Tower.js'
import { BlockGeometry } from './lib/BlockGeometry.js'
import { TetrominoGeometry } from './lib/TetrominoGeometry.js'
import { Debris } from './lib/Debris.js'
import { Sounds } from './lib/Sounds.js'
import FastSimplexNoise from '@webvoxel/fast-simplex-noise'
import { EnergySystem } from './systems/EnergySystem.js'
import { FlowField } from './systems/FlowField.js'
import { Enclosure } from './systems/Enclosure.js'
import { TileBag } from './systems/TileBag.js'
import { Upkeep } from './systems/Upkeep.js'
import { RangeVisuals } from './systems/RangeVisuals.js'
import { LotGrowth } from './systems/LotGrowth.js'
import { TowerInteraction } from './systems/TowerInteraction.js'
import { CityGenerator } from './systems/CityGenerator.js'
import { TowerRenderer } from './systems/TowerRenderer.js'
import { ACCENT_COLORS } from './palette.js'
import { Buffs } from './buffs.js'
import { TopType, isTurret, isGenerator, towerArea, towerTopY, roofGeomIndex, isEnclosureGenerator, isGrey, isShield, claimsEnclosure, shieldRadiusCells, KING_HEALTH } from './blockTypes.js'
import { fxMaterial, glow } from './fx.js'

// Energy pulses a generator fires per floor before that floor crumbles away.
// A generator's life is therefore its height: a 4-storey gen lasts 4x as long as
// a 1-storey one, so building tall is an investment in uptime rather than just
// output. It visibly shrinks as it burns down, and dies when the last floor goes.
const MAX_GENS = 30 // hard cap on simultaneously placed generators

// Rotate a vec3 around Y axis by angle (in radians)
const rotateY = (v, angle) => {
  const c = cos(angle)
  const s = sin(angle)
  return vec3(
    v.x.mul(c).add(v.z.mul(s)),
    v.y,
    v.z.mul(c).sub(v.x.mul(s))
  )
}


export class City {
  // City size in lots (9x9 = 81 lots, 45x45 cells, 90x90 world units).
  //
  // Odd on purpose: an odd count has a true middle lot, so the centre cell
  // (floor(45/2) = 22) is both the centre of the board AND the middle of the
  // centre 5x5 lot, which is where the king wants to be. An even count has
  // neither.
  //
  // Everything downstream derives from this - creep spawn ring, shadow bounds
  // and the zoom-out cap all read actualGridWidth rather than hardcoding it.
  static CITY_SIZE_LOTS = 11

  constructor(scene, params) {
    this.scene = scene
    this.params = params

    this.towers = []
    this.towerMesh = null
    this.towerMaterial = null
    this.dummy = new Object3D()
    this.towerSize = new Vector2(1, 1)
    this.towerCenter = new Vector2()

    // City height distribution noise - lower frequency for larger "neighborhoods"
    this.noiseFrequency = params.scene.noiseScale
    this.cityNoise = new FastSimplexNoise({
      frequency: this.noiseFrequency,
      octaves: 3,
      min: 0,
      max: 1,
      persistence: 0.6,
    })
    this.heightNoiseScale = params.scene.noiseHeight
    this.randHeightAmount = params.scene.randHeight
    this.randHeightPower = params.scene.randHeightPower
    this.noiseSubtract = params.scene.noiseSubtract
    this.centerFalloff = params.scene.centerFalloff
    this.skipChance = params.scene.skipChance

    this.actualGridWidth = 0
    this.actualGridHeight = 0

    // Accent colors for lit towers, trails, and new floors
    // The lighten pass lives in palette.js so the DOM hexes are the same values.
    this.accentColors = ACCENT_COLORS.map(c => c.clone())
    this.instanceToTower = new Map() // Maps instance ID to tower

    // Floor stacking config
    this.maxFloors = 5
    this.floorHeight = 2

    // Debris system
    this.debris = new Debris(scene, params.material)

    // Resource meter (set by Demo). Each build click spends 1 mana.
    this.mana = null

    // Power-line connectors / generators (Trails instance set by Demo).
    this.trails = null

    // Floating "+N" energy captions (FloatingText instance set by Demo).
    this.floatingText = null

    // Energy generation + glow/caption feedback (path/adj generators, grey mana).
    this.energy = new EnergySystem(this)
    this.flow = new FlowField(this)
    this.enclosure = new Enclosure(this)
    this.tileBag = new TileBag()
    this.upkeep = new Upkeep(this)
    this.introDone = false // set when startIntroAnimation's camera move lands

    // The city grid: 2D array of lots (populated by initGrid).
    this.lots = []
    // When true, clicks (build/destroy/spawn) don't cost mana (GUI toggle).
    this.freeClicks = false

    // Outward growth: dormant lots spawn from neighbour strength + clicks, plus
    // the lot outlines / progress fills.
    this.lotGrowth = new LotGrowth(this)

    // Player input (hover/build/destroy/reroll) + the reroll build-wheel.
    this.interaction = new TowerInteraction(this)

    // Procedural lot generation: footprints, types, and heights.
    this.generator = new CityGenerator(this)

    // Runtime tower visuals: accent coloring, visibility, reroll, empty-tower
    // lifecycle (on the shared BatchedMesh built in initTowers).
    this.renderer = new TowerRenderer(this)

    // Ground rings for zones of control + turret range, and the turret-circle
    // data for the post-process coverage glow.
    this.rangeVisuals = new RangeVisuals(this)
  }

  async init() {
    await BlockGeometry.init()
    this.initGrid()
    await this.initTowers()
    this.placeKing() // central king piece (must exist before the cluster seeds around it)
    // no starting cluster — player builds from scratch around the king
    this.updateMatrices()
    this.renderer.recalculateVisibility()
    this.energy.refreshManaStats()
  }

  initGrid() {
    // A buildable "cell" is 2 world units (a 2x2 block of the original cells).
    this.cellUnit = 2
    // Lot layout (world units): 10-unit lots (5 cells) separated by 4-unit roads (2 cells)
    this.lotSize = 10
    this.roadWidth = 0 // lots are adjacent (no road gaps): one continuous grid
    this.cellSize = this.lotSize + this.roadWidth // 10 world units per lot pitch

    // City dimensions from static constant
    this.numLotsX = City.CITY_SIZE_LOTS
    this.numLotsY = City.CITY_SIZE_LOTS

    // Store actual grid dimensions for centering
    this.actualGridWidth = this.numLotsX * this.cellSize
    this.actualGridHeight = this.numLotsY * this.cellSize

    // Calculate center lot for positioning
    this.centerLotX = Math.floor(this.numLotsX / 2)
    this.centerLotZ = Math.floor(this.numLotsY / 2)

    // Grid offset: centre the WHOLE BOARD on the origin.
    //
    // This used to centre the centre LOT instead, which is the same thing only
    // when the lot count is odd. At 7 lots both give -35; at 10 there is no
    // middle lot, and centring lot 5 put the board at -55..45 with every cell
    // boundary on an odd world coordinate while the drawn grid (centred, so
    // even) sat 1 unit away - the half-cell offset between tiles and the floor.
    this.gridOffsetX = -this.actualGridWidth / 2
    this.gridOffsetZ = -this.actualGridHeight / 2

    // Buildable cells per lot side (5x5 grid of 1-cell slots), and the single
    // global cell grid spanning the whole city (lots are contiguous, so tiles
    // can straddle lot boundaries). occupied[gy][gx] tracks taken cells.
    this.lotCells = this.lotSize / this.cellUnit
    this.gridCellsX = this.numLotsX * this.lotCells
    this.gridCellsY = this.numLotsY * this.lotCells
    this.occupied = Array.from({ length: this.gridCellsY }, () => Array(this.gridCellsX).fill(false))

    // Only the CENTER lot is pre-generated (the old varied, pre-built model).
    // Every other lot starts as an empty grid the player fills from the tile
    // palette via free placement (see placeTileFree). occupied[][] tracks which
    // cells are taken; the center lot is marked fully occupied (no free-place).
    // Every lot starts empty + active. The starting cluster of tiles is placed in
    // generateStartCluster() (after the tower pool exists), as ordinary placed
    // tiles, so there's no special pre-built center lot anymore.
    this.lots = []
    for (let lotY = 0; lotY < this.numLotsY; lotY++) {
      const row = []
      for (let lotX = 0; lotX < this.numLotsX; lotX++) {
        const lotColorIndex = MathUtils.randInt(0, this.accentColors.length - 1)
        row.push({ lotX, lotY, colorIndex: lotColorIndex, towers: [], active: true })
      }
      this.lots.push(row)
    }
  }

  /**
   * Convert grid coordinates to world coordinates
   * Grid coords: 0 to actualGridWidth/Height
   * World coords: centered at origin
   * @param {number} gridX - X position in grid space
   * @param {number} gridZ - Z position in grid space (note: grid uses Y, world uses Z)
   * @returns {{x: number, z: number}} World position
   */
  gridToWorld(gridX, gridZ) {
    return {
      x: gridX + this.gridOffsetX,
      z: gridZ + this.gridOffsetZ
    }
  }

  /** Map a world-space ground point to a global cell (gx,gy), or null if OOB. */
  worldToCell(worldX, worldZ) {
    const gx = Math.floor((worldX - this.gridOffsetX) / this.cellUnit)
    const gy = Math.floor((worldZ - this.gridOffsetZ) / this.cellUnit)
    if (gx < 0 || gy < 0 || gx >= this.gridCellsX || gy >= this.gridCellsY) return null
    return { gx, gy }
  }

  /** The lot that owns a global cell. */
  cellLot(gx, gy) {
    return this.lots[Math.floor(gy / this.lotCells)][Math.floor(gx / this.lotCells)]
  }

  /**
   * Whether a footprint (list of [dx,dy] cell offsets) anchored at global cell
   * (gx,gy) is free, in-bounds, and entirely within active lots.
   */
  fits(gx, gy, cells, claimColor = -1) {
    for (const [dx, dy] of cells) {
      const x = gx + dx, y = gy + dy
      if (x < 0 || y < 0 || x >= this.gridCellsX || y >= this.gridCellsY) return false
      if (this.occupied[y][x]) return false
      if (!this.cellLot(x, y).active) return false
      // A coloured tile can't enter a region already claimed by another colour.
      if (claimColor >= 0 && this.cellClaim) {
        const cc = this.cellClaim[y * this.gridCellsX + x]
        if (cc >= 0 && cc !== claimColor) return false
      }
    }
    return true
  }

  /**
   * Place a palette tile freely into empty cells. `cells` is the footprint
   * (offsets from gx,gy); `opts` carries render info: { tetro?: {name,rot},
   * typeTop, colorIndex, topColorIndex }. Grabs a pooled tower, builds it at
   * level 0. Returns the tower or null if the pool is exhausted.
   */
  placeTileFree(gx, gy, cells, opts, silent = false) {
    const t = this.towerPool.pop()
    if (!t) return null

    const w = Math.max(...cells.map((c) => c[0])) + 1
    const h = Math.max(...cells.map((c) => c[1])) + 1
    const x0 = gx * this.cellUnit
    const z0 = gy * this.cellUnit
    t.box.min.set(x0, z0)
    t.box.max.set(x0 + w * this.cellUnit, z0 + h * this.cellUnit)
    const lot = this.cellLot(gx, gy) // lot membership by anchor cell
    t.lotX = lot.lotX
    t.lotY = lot.lotY
    t.cellX = gx
    t.cellY = gy
    t.cells = cells
    t.tetro = opts.tetro || null // { name, rot } for tetromino walls, else null
    t.king = opts.king || false // the central king piece (lose it = game over)
    t.startCluster = false // player tiles count toward escalating cost; start cluster doesn't
    t.dormant = false
    t.empty = false
    t.emptyTower = false
    t.placed = true
    t.visible = true
    t.numFloors = 0
    t.rotation = opts.rotation || 0 // corner-shaped roofs (shield/barracks) have a facing
    t.resetAnimation() // belt and braces: nothing in-flight from a previous life
    t.skipFactor = 2 // always passes visibility
    t.colorIndex = opts.colorIndex
    t.typeTop = opts.typeTop
    t.setTopColorIndex(opts.topColorIndex)

    for (const [dx, dy] of cells) this.occupied[gy + dy][gx + dx] = true
    lot.towers.push(t)

    this.renderer.applyTileVisuals(t)
    this.updateTowerMatrices(t)
    if (!silent) Sounds.play('pop', 0.8, 0.15, 0.7)
    this.onTowerChanged(t)
    this.enclosure.update()
    return t
  }

  /** Demolish a freely-placed tower (right-click): debris + free its cells. */
  demolishPlaced(tower) {
    const center = tower.box.getCenter(this.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * this.floorHeight
    this.debris.spawn(center.x + this.gridOffsetX, y, center.y + this.gridOffsetZ, 0.8,
      tower.litColor || tower.baseColor, 12)
    Sounds.play('break2', 1.0, 0.2)
    this.freePlacedTower(tower)
  }

  /** Free a placed tower's cells and return it to the pool (no debris/sound). */
  freePlacedTower(tower) {
    for (const [dx, dy] of tower.cells) this.occupied[tower.cellY + dy][tower.cellX + dx] = false
    const lot = this.lots[tower.lotY][tower.lotX]
    const k = lot.towers.indexOf(tower)
    if (k >= 0) lot.towers.splice(k, 1)

    // Land any running animation before the tower goes back in the pool. A
    // half-finished roof tween left roofAnimating stuck true, and the next tile
    // to reuse this slot inherited both the flag and the old footprint scale.
    tower.resetAnimation()
    tower.placed = false
    tower.dormant = true
    tower.tetro = null
    tower.visible = false
    tower.numFloors = 0
    this.updateTowerMatrices(tower)
    this.towerPool.push(tower)
    this.onTowerChanged(tower)
    this.enclosure.update()
  }

  /** Free a tower's cells and remove it (no debris). Placed tiles return to the
   *  pool; pre-built center-lot towers free their footprint and hide. */
  demolishTower(tower) {
    if (tower.placed) { this.freePlacedTower(tower); return }
    const cu = this.cellUnit
    const gx0 = Math.round(tower.box.min.x / cu), gy0 = Math.round(tower.box.min.y / cu)
    const tw = Math.round((tower.box.max.x - tower.box.min.x) / cu)
    const th = Math.round((tower.box.max.y - tower.box.min.y) / cu)
    for (let j = 0; j < th; j++) {
      for (let i = 0; i < tw; i++) {
        const x = gx0 + i, y = gy0 + j
        if (x >= 0 && y >= 0 && x < this.gridCellsX && y < this.gridCellsY) this.occupied[y][x] = false
      }
    }
    tower.visible = false
    tower.numFloors = 0
    this.onTowerChanged(tower)
    this.enclosure.update()
  }

  /** The shared bag lives in TileBag; this is the name TilePalette already uses. */
  drawTileSpec() { return this.tileBag.draw() }

  /** Place the king: a 1x1 tower at the exact centre with the hole roof, in a
   *  random light accent colour. Losing it
   *  (creeps knock it to 0 floors) ends the game. */
  placeKing() {
    // Middle of the board in cells. Derived from the cell grid rather than from
    // a "centre lot", which doesn't exist for an even lot count.
    const ccx = Math.floor(this.gridCellsX / 2)
    const ccy = Math.floor(this.gridCellsY / 2)
    // One of the three light city accents, drawn per game, so the piece you're
    // defending isn't the same colour every run.
    const kingColor = MathUtils.randInt(0, this.accentColors.length - 1)
    // HOLE is an otherwise-unused top type, so the king gets a distinct roof
    // without being picked up by isGenerator/isTurret anywhere.
    const t = this.placeTileFree(ccx, ccy, [[0, 0]], {
      typeTop: TopType.HOLE, colorIndex: kingColor, topColorIndex: kingColor, king: true,
    }, true)
    if (!t) return
    t.numFloors = this.kingMaxFloors || KING_HEALTH
    this.updateTowerMatrices(t)
    this.king = t
    this.kingAlive = true
    this.createKingBeam()
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
    if (!this.king) return
    const H = 160 // tall enough to leave frame at every zoom level
    // Open-ended: the caps would read as bright discs from a high camera.
    const geo = new CylinderGeometry(0.16, 0.16, H, 12, 1, true)
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: this.accentColors[this.king.colorIndex].clone(),
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
    this.scene.add(mesh)
    this.kingBeam = mesh
    this.kingBeamHeight = H
    this.updateKingBeam()
  }

  /** Keep the beam standing on the king's roof as the king loses floors. */
  updateKingBeam() {
    const beam = this.kingBeam
    if (!beam) return
    const king = this.king
    // Held back until the opening build-up finishes: the beam is a marker for a
    // city that exists, and firing it up while the towers are still rising drew
    // the eye away from the one animation that only plays once.
    if (!king || !king.visible || !this.kingAlive || !this.introDone) {
      beam.visible = false
      return
    }
    beam.visible = true
    const c = king.box.getCenter(this.towerCenter)
    // Rooted at ground level rather than on the roof, so it reads as coming out
    // of the tower rather than hovering above it - and it no longer bobs up and
    // down as the king loses and regains floors.
    beam.position.set(
      c.x + this.gridOffsetX,
      this.kingBeamHeight / 2,
      c.y + this.gridOffsetZ
    )
  }

  /** Fire the game-over hook once (the king died). */
  triggerGameOver() {
    if (!this.kingAlive) return
    this.kingAlive = false
    this.onGameOver?.()
  }

  async initTowers() {
    // Material values set by applyParams
    const mat = new MeshPhysicalNodeMaterial()
    this.towerMaterial = mat

    // Environment rotation uniform (radians)
    this.envRotation = uniform(0)

    // Custom environment node with rotation support
    // We'll set this up after the scene environment is loaded
    this.setupEnvRotation()

    const geoms = []
    for (let i = 0; i < BlockGeometry.geoms.length; i++) {
      geoms.push(BlockGeometry.geoms[i])
    }

    const vCounts = []
    const iCounts = []
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i]
      vCounts.push(g.attributes.position.count)
      iCounts.push(g.index.count)
    }

    // Procedural tetromino geometries (grey wall tiles) added alongside the GLB
    // blocks. Each entry has a body (stacked per floor) + a thin roof cap.
    const tetroList = TetrominoGeometry.build(this.cellUnit)

    // Geometry buffer = the unique block geometries (added once, shared by all
    // instances). Instances (center towers + the free-placement pool) reference
    // them by id and add no vertices.
    let totalV = 0
    let totalI = 0
    for (let i = 0; i < geoms.length; i++) { totalV += vCounts[i]; totalI += iCounts[i] }
    for (const e of tetroList) {
      totalV += e.body.attributes.position.count + e.roof.attributes.position.count
      totalI += e.body.index.count + e.roof.index.count
    }

    // Center-lot towers + a pool of generic towers grabbed on free placement.
    this.poolSize = 900
    const totalTowers = this.towers.length + this.poolSize
    const maxInstances = totalTowers * (this.maxFloors + 1) + 10
    this.towerMesh = new BatchedMesh(maxInstances, totalV, totalI, mat)
    this.towerMesh.sortObjects = false
    this.towerMesh.castShadow = true
    this.towerMesh.receiveShadow = true
    // Center the middle lot at the origin (use pre-calculated offset)
    this.towerMesh.position.x = this.gridOffsetX
    this.towerMesh.position.z = this.gridOffsetZ
    this.scene.add(this.towerMesh)

    const geomIds = []
    for (let i = 0; i < geoms.length; i++) {
      geomIds.push(this.towerMesh.addGeometry(geoms[i]))
    }
    this.geomIds = geomIds // kept for runtime tile re-rolls on destroy

    // Register tetromino geometries; lookup by `${name}:${rot}`.
    this.tetroGeom = new Map()
    for (const e of tetroList) {
      this.tetroGeom.set(`${e.name}:${e.rot}`, {
        bodyId: this.towerMesh.addGeometry(e.body),
        roofId: this.towerMesh.addGeometry(e.roof),
        cells: e.cells,
        body: e.body, // standalone geometry, reused for the drag ghost
      })
    }

    // Create instances for each tower: maxFloors base + 1 roof
    for (let i = 0; i < this.towers.length; i++) {
      const tower = this.towers[i]
      tower.floorInstances = []

      // Create floor instances (base geometry)
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = this.towerMesh.addInstance(geomIds[tower.typeBottom])
        this.towerMesh.setColorAt(idx, tower.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        tower.floorInstances.push(idx)
        this.instanceToTower.set(idx, tower)
      }

      // Create roof instance (top geometry)
      tower.roofInstance = this.towerMesh.addInstance(geomIds[roofGeomIndex(tower.typeTop)])
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
      this.towerMesh.setVisibleAt(tower.roofInstance, false)
      this.instanceToTower.set(tower.roofInstance, tower)
    }

    // Free-placement pool: generic hidden towers, each pre-allocated maxFloors+1
    // instances. A tile drop grabs one (placeTileFree); demolish returns it.
    this.towerPool = []
    const defBottom = BlockGeometry.topToBottom.get(0)
    for (let p = 0; p < this.poolSize; p++) {
      const t = new Tower()
      t.dormant = true
      t.visible = false
      t.placed = false
      t.typeTop = 0
      t.typeBottom = defBottom
      t.floorInstances = []
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = this.towerMesh.addInstance(geomIds[defBottom])
        this.towerMesh.setColorAt(idx, t.baseColor)
        this.towerMesh.setVisibleAt(idx, false)
        t.floorInstances.push(idx)
        this.instanceToTower.set(idx, t)
      }
      t.roofInstance = this.towerMesh.addInstance(geomIds[0])
      this.towerMesh.setColorAt(t.roofInstance, t.topColor)
      this.towerMesh.setVisibleAt(t.roofInstance, false)
      this.instanceToTower.set(t.roofInstance, t)
      this.towers.push(t)
      this.towerPool.push(t)
    }

    console.log('Tower count:', this.towers.length, 'Max instances:', maxInstances)

    // Light up all plus/cross towers with hover colors
    this.renderer.applyLitTowers()
  }

  /**
   * Intro animation: build all towers from ground up, staggered from center outward
   * @param {Camera} camera - The camera to animate
   * @param {OrbitControls} controls - OrbitControls instance
   * @param {number} duration - Total animation duration in seconds
   */
  startIntroAnimation(camera, controls, duration = 4) {
    const gridCenterX = this.actualGridWidth / 2
    const gridCenterY = this.actualGridHeight / 2

    // Mute build sounds during intro (except pop) and disable debris
    Sounds.mute(['stone', 'tick', 'clink'])
    const debrisWasEnabled = this.debris.enabled
    this.debris.enabled = false

    // 1. Store target floor counts, set all to 0. Only visible towers build;
    //    hidden slots (empty/dormant) keep targetFloors 0 so they aren't flashed
    //    in and then erased when updateTowerMatrices re-hides them.
    const towerData = this.towers.map(tower => {
      const targetFloors = tower.visible ? tower.numFloors : 0
      const center = tower.box.getCenter(new Vector2())
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      tower.numFloors = 0
      return { tower, targetFloors, dist }
    })
    this.updateMatrices()

    // 2. Sort by distance (center first). Normalize the stagger against the
    //    farthest *building* tower (not the whole-city diagonal), so the active
    //    lot ripples across the full stagger window instead of starting at once.
    towerData.sort((a, b) => a.dist - b.dist)
    const building = towerData.filter(t => t.targetFloors > 0)
    const maxDist = building[building.length - 1]?.dist || 1

    // 3. Animate each tower's floors with stagger
    const staggerDuration = duration * 0.85 // 85% of duration for stagger spread
    const floorDelay = 0.25 // 250ms between floors of same tower

    let maxDelay = 0
    towerData.forEach(({ tower, targetFloors, dist }) => {
      if (targetFloors === 0) return

      const staggerDelay = (dist / maxDist) * staggerDuration

      // Animate each floor sequentially (no debris during intro)
      const baseColor = tower.isLit && tower.litColor ? tower.litColor : tower.baseColor
      const newFloorColor = Tower.lightenColor(baseColor)
      // Volume fades based on distance (0 at 3 lots away)
      const maxSoundDist = this.cellSize * 3 // 3 lots
      const volume = Math.max(0, 1 - dist / maxSoundDist) * 0.35
      for (let f = 0; f < targetFloors; f++) {
        const delay = staggerDelay + f * floorDelay
        maxDelay = Math.max(maxDelay, delay)
        setTimeout(() => {
          tower.numFloors = f + 1
          // Play pop sound with pitch based on floor height, volume based on distance
          const pitch = 0.8 + (f / this.maxFloors) * 1.2
          if (volume > 0) Sounds.play('pop', pitch, 0.15, volume)
          tower.animateNewFloor(
            this.towerMesh,
            this.floorHeight,
            f,
            newFloorColor,
            () => this.updateTowerMatrices(tower),
            null // no debris
          )
        }, delay * 1000)
      }
    })

    // Unmute sounds and restore debris after intro completes. Also refresh
    // tower visuals once so monasteries/connectors reflect the settled city
    // (the intro builds via updateTowerMatrices, which skips that pass).
    setTimeout(() => {
      Sounds.unmute(['stone', 'tick', 'clink'])
      this.debris.enabled = debrisWasEnabled
      this.updateTowerVisuals()
    }, (maxDelay + 1) * 1000)

    // 4. Camera zoom animation (angle-based distance)
    const target = controls.target.clone()
    const direction = camera.position.clone().sub(target).normalize()
    const endDist = camera.position.distanceTo(target)
    const startDist = endDist * 3

    // Set initial zoomed-out position
    camera.position.copy(target).addScaledVector(direction, startDist)

    // Disable user input during the zoom tween - gsap and OrbitControls fighting
    // over the camera leaves the controls in a bad state (pan reads as rotate).
    controls.enabled = false

    // Animate distance only
    const animState = { dist: startDist }
    gsap.to(animState, {
      dist: endDist,
      duration: duration,
      ease: 'power2.out',
      onUpdate: () => {
        camera.position.copy(target).addScaledVector(direction, animState.dist)
        controls.update()
      },
      onComplete: () => {
        controls.enabled = true
        this.introDone = true
      },
    })
  }

  updateMatrices() {
    if (!this.towerMesh) return
    const { dummy, towerMesh, towers } = this

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]

      // Hide all instances if tower is not visible
      if (tower.visible === false) {
        for (let f = 0; f < this.maxFloors; f++) {
          towerMesh.setVisibleAt(tower.floorInstances[f], false)
        }
        towerMesh.setVisibleAt(tower.roofInstance, false)
        continue
      }

      // Tetromino walls: geometry encodes the multi-cell shape at cell scale,
      // centred on the bounding box. No footprint scaling or rotation.
      if (tower.tetro) {
        const c = tower.box.getCenter(this.towerCenter)
        const ax = c.x, az = c.y
        const nf = tower.numFloors
        const fhh = this.floorHeight / 2
        for (let f = 0; f < this.maxFloors; f++) {
          const idx = tower.floorInstances[f]
          if (f < nf) {
            dummy.position.set(ax, f * this.floorHeight + fhh, az)
            dummy.scale.set(1, this.floorHeight, 1)
            dummy.rotation.y = 0
            dummy.updateMatrix()
            towerMesh.setMatrixAt(idx, dummy.matrix)
            towerMesh.setVisibleAt(idx, true)
          } else {
            towerMesh.setVisibleAt(idx, false)
          }
        }
        dummy.position.set(ax, nf * this.floorHeight + TetrominoGeometry.roofHalf, az)
        dummy.scale.set(1, 1, 1)
        dummy.rotation.y = 0
        dummy.updateMatrix()
        towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
        towerMesh.setVisibleAt(tower.roofInstance, true)
        continue
      }

      const center = tower.box.getCenter(this.towerCenter)
      const size = tower.box.getSize(this.towerSize)
      const numFloors = tower.numFloors

      // Half-heights for centered geometries
      const floorHalfHeight = this.floorHeight / 2 // Base geom is 1 unit, scaled to floorHeight
      const roofHalfHeight = BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

      // Position and show floor instances (geometry centered, so add halfHeight)
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = tower.floorInstances[f]
        if (f < numFloors) {
          dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
          dummy.scale.set(size.x, this.floorHeight, size.y)
          dummy.rotation.y = tower.rotation
          dummy.updateMatrix()
          towerMesh.setMatrixAt(idx, dummy.matrix)
          towerMesh.setVisibleAt(idx, true)
        } else {
          towerMesh.setVisibleAt(idx, false)
        }
      }

      // Position roof on top (geometry centered, so add halfHeight)
      dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
      dummy.scale.set(size.x, 1, size.y)
      dummy.rotation.y = tower.rotation
      dummy.updateMatrix()
      towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
      towerMesh.setVisibleAt(tower.roofInstance, true)
    }
  }

  regenerate() {
    // Re-randomize all tower properties and recalculate the city. Skip the free-
    // placement pool (dormant) and player-placed tiles - only the pre-built
    // center lot regenerates.
    for (const tower of this.towers) {
      if (tower.dormant || tower.placed) continue
      tower.randFactor = MathUtils.randFloat(0, 1)
      tower.skipFactor = MathUtils.randFloat(0, 1)
      tower.colorIndex = MathUtils.randInt(0, 2)
      tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
      // Reset to base colors first
      tower.isLit = false
      for (const idx of tower.floorInstances) {
        this.towerMesh.setColorAt(idx, tower.baseColor)
      }
      this.towerMesh.setColorAt(tower.roofInstance, tower.topColor)
    }
    // Regenerate noise with new seed
    this.generator.recalculateNoise()
    this.renderer.recalculateVisibility()
    // Re-apply lit towers
    this.renderer.applyLitTowers()
  }

  setupEnvRotation() {
    const mat = this.towerMaterial
    const angle = this.envRotation

    // Get the environment texture from scene
    const envTexture = this.scene.environment
    if (!envTexture) {
      console.warn('Environment texture not yet loaded')
      return
    }

    // Create rotated reflection vector for specular
    // Reflection is computed in view space, transform to world, then rotate
    const reflectView = positionViewDirection.negate().reflect(normalWorld)
    const reflectWorld = reflectView.transformDirection(cameraViewMatrix)
    const rotatedReflectWorld = rotateY(reflectWorld, angle)

    // Create PMREM texture node with rotated UV direction
    const envMapNode = pmremTexture(envTexture, rotatedReflectWorld, roughness)

    // Set as the material's environment node
    mat.envNode = envMapNode
  }

  /**
   * Called after a tower's floor count changes (build or destroy).
   * Updates its matrices and re-evaluates power-line connectors.
   */
  onTowerChanged(tower) {
    this.updateTowerMatrices(tower)
    // The roof takes the shade of the floor it sits on, so the stack gradient
    // has to be redrawn whenever the height changes.
    if (isGrey(tower)) this.renderer.shadeStack(tower)
    this.lotGrowth.trySpawnLots()
    this.updateTowerVisuals()
    this.flowDirty = true // creep pathing depends on walls/goals
  }

  /** Creep pathfinding lives in FlowField; kept here as the name callers use. */
  computeFlowField() { this.flow.compute() }

  /**
   * Refresh connector lines, ZOC circles, and lot fills (no matrix update or
   * lot spawning). Called the instant a block is added so the radius/connections
   * grow with the new block instead of lagging behind its emerge animation.
   */
  updateTowerVisuals() {
    this.energy.refresh()
    this.rangeVisuals.refresh()
    this.lotGrowth.updateLotFills()
  }

  /** Turret range circles for the post-process coverage glow (called by Demo). */
  getTurretCircles(out = []) {
    return this.rangeVisuals.getTurretCircles(out)
  }


  /**
   * Ring that bursts out of a building the moment a support tower reaches it.
   *
   * Expo-out so it snaps wide immediately and eases to a stop, fading bright to
   * nothing - the point is to say "this just changed" at a glance across a board
   * that may have a hundred creeps on it.
   */
  spawnSupportRing(x, z, color) {
    if (!this._supportRingGeo) {
      // Unit disc, scaled per burst. Flat on the ground, drawn over it.
      this._supportRingGeo = new CircleGeometry(1, 40)
      this._supportRingGeo.rotateX(-Math.PI / 2)
    }
    const mat = fxMaterial(new MeshBasicNodeMaterial({
      color: color.clone(), opacity: 0.85,
    }))
    const mesh = glow(new Mesh(this._supportRingGeo, mat))
    mesh.position.set(x, 0.09, z)
    mesh.scale.setScalar(0.01)
    mesh.renderOrder = 5
    this.scene.add(mesh)
    gsap.to(mesh.scale, {
      x: this.cellUnit * 3.2, y: 1, z: this.cellUnit * 3.2,
      duration: 0.75, ease: 'expo.out',
    })
    gsap.to(mat, {
      opacity: 0, duration: 0.75, ease: 'expo.out',
      onComplete: () => { this.scene.remove(mesh); mat.dispose() },
    })
  }

  /** Set every instance color of a tower to a single color. */
  setTowerColor(tower, color) {
    const mesh = this.towerMesh
    for (const idx of tower.floorInstances) mesh.setColorAt(idx, color)
    mesh.setColorAt(tower.roofInstance, color)
  }

  /** Per-frame: debris, reroll build-wheels, and the energy system. */
  update(dt) {
    this.debris.update(dt)
    this.interaction.update(dt)
    this.energy.update(dt)
    this.upkeep.update(dt)
    this.flowView?.update()
    this.pathPreview?.update()
    this.updateKingBeam()
  }

  /** Count currently-placed generators (for the MAX_GENS cap). */
  countGens() {
    let n = 0
    for (const t of this.towers) if (t.visible && isGenerator(t)) n++
    return n
  }

  /** Whether another generator may be placed (under the cap). */
  canPlaceGen() {
    return this.countGens() < MAX_GENS
  }

  /** Cumulative count of how many of a cost-bucket key the PLAYER has placed over
   *  the whole game (only ever rises - expiry/demolish don't lower it), so the
   *  escalating price keeps climbing even though gens expire. */
  recordPlacement(key) {
    if (!this._placedCounts) this._placedCounts = new Map()
    this._placedCounts.set(key, (this._placedCounts.get(key) || 0) + 1)
  }

  placedCount(key) {
    return this._placedCounts ? (this._placedCounts.get(key) || 0) : 0
  }

  /**
   * Generators used to burn down: a countdown pie on top, a floor lost every
   * N energy pulses, and a lifetime cap on how many floors one would accept.
   * All removed - a generator is an ordinary tower now: it stays up and can
   * be built back to full height whenever you like. What gates its output
   * instead is whether it's linked to a support tower.
   */

  /** True if a generator is actively producing mana right now (so its lifespan
   *  should tick): needs height and to be in one of the energy system's active
   *  sets — connected path or a claimed enclosure. */
  genIsProducing(t) {
    if (t.numFloors < 1) return false
    const e = this.energy
    return e.connectedTowers.has(t) || e.enclosureGens.includes(t)
  }

  /**
   * Update matrices for a single tower
   */
  updateTowerMatrices(tower) {
    const { dummy, towerMesh } = this

    // Hidden tower: hide all of its instances (floors + roof) and bail.
    if (tower.visible === false) {
      for (let f = 0; f < this.maxFloors; f++) {
        towerMesh.setVisibleAt(tower.floorInstances[f], false)
      }
      towerMesh.setVisibleAt(tower.roofInstance, false)
      return
    }

    // Tetromino walls: geometry at cell scale, centred on the bounding box.
    if (tower.tetro) {
      const c = tower.box.getCenter(this.towerCenter)
      const ax = c.x, az = c.y
      const nf = tower.numFloors
      const fhh = this.floorHeight / 2
      for (let f = 0; f < this.maxFloors; f++) {
        const idx = tower.floorInstances[f]
        if (f < nf) {
          dummy.position.set(ax, f * this.floorHeight + fhh, az)
          dummy.scale.set(1, this.floorHeight, 1)
          dummy.rotation.y = 0
          dummy.updateMatrix()
          towerMesh.setMatrixAt(idx, dummy.matrix)
          towerMesh.setVisibleAt(idx, true)
        } else {
          towerMesh.setVisibleAt(idx, false)
        }
      }
      towerMesh.setVisibleAt(tower.roofInstance, true)
      if (tower.roofAnimating) return
      dummy.position.set(ax, nf * this.floorHeight + TetrominoGeometry.roofHalf, az)
      dummy.scale.set(1, 1, 1)
      dummy.rotation.y = 0
      dummy.updateMatrix()
      towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
      return
    }

    const center = tower.box.getCenter(this.towerCenter)
    const size = tower.box.getSize(this.towerSize)
    const numFloors = tower.numFloors

    // Half-heights for centered geometries
    const floorHalfHeight = this.floorHeight / 2
    const roofHalfHeight = BlockGeometry.halfHeights[roofGeomIndex(tower.typeTop)]

    for (let f = 0; f < this.maxFloors; f++) {
      const idx = tower.floorInstances[f]
      if (f < numFloors) {
        dummy.position.set(center.x, f * this.floorHeight + floorHalfHeight, center.y)
        dummy.scale.set(size.x, this.floorHeight, size.y)
        dummy.rotation.y = tower.rotation
        dummy.updateMatrix()
        towerMesh.setMatrixAt(idx, dummy.matrix)
        towerMesh.setVisibleAt(idx, true)
      } else {
        towerMesh.setVisibleAt(idx, false)
      }
    }

    // A visible tower always shows its roof (even at level 0, roof-only).
    towerMesh.setVisibleAt(tower.roofInstance, true)

    // Skip roof matrix if animation is in progress (roof controlled by GSAP)
    if (tower.roofAnimating) return

    // Roof on top
    dummy.position.set(center.x, numFloors * this.floorHeight + roofHalfHeight, center.y)
    dummy.scale.set(size.x, 1, size.y)
    dummy.rotation.y = tower.rotation
    dummy.updateMatrix()
    towerMesh.setMatrixAt(tower.roofInstance, dummy.matrix)
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
    const hw = this.actualGridWidth / 2, hh = this.actualGridHeight / 2
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
      color: 0xffffff,
      linewidth: 2, // screen pixels, because worldUnits is false
      worldUnits: false,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    })
    // Line2 needs the viewport to convert pixel width into clip space.
    mat.resolution = new Vector2(window.innerWidth, window.innerHeight)
    const line = new Line2(geom, mat)
    line.computeLineDistances()
    line.renderOrder = 4
    line.frustumCulled = false
    this.scene.add(line)
    this.boardOutline = line
  }

  /** Keep the outline's pixel width correct across resizes. */
  onResize(w, h) {
    if (this.boardOutline) this.boardOutline.material.resolution.set(w, h)
  }

  createGrids() {
    this.createBoardOutline()
    // Fine cell grid - centered at origin (same as lot grid). One line per buildable cell.
    const cellGrid = new GridHelper(this.actualGridWidth, this.actualGridWidth / this.cellUnit, 0x888888, 0x888888)
    cellGrid.material.transparent = true
    cellGrid.material.opacity = 0.5
    cellGrid.position.set(0, 0.01, 0)
    this.scene.add(cellGrid)
    this.cellGrid = cellGrid

    // Grid intersection dots using procedural plane shader
    const dotPlaneGeometry = new PlaneGeometry(this.actualGridWidth, this.actualGridHeight)
    dotPlaneGeometry.rotateX(-Math.PI / 2)
    const dotMaterial = new MeshBasicNodeMaterial()
    dotMaterial.transparent = true
    dotMaterial.alphaTest = 0.5
    dotMaterial.side = 2 // DoubleSide

    // Procedural dots at grid intersections (one per buildable cell, matching cell grid)
    const cellCoord = uv().mul(this.actualGridWidth / this.cellUnit)
    const fractCoord = fract(cellCoord)
    const toGridX = min(fractCoord.x, float(1).sub(fractCoord.x))
    const toGridY = min(fractCoord.y, float(1).sub(fractCoord.y))
    const dist = toGridX.mul(toGridX).add(toGridY.mul(toGridY)).sqrt()
    const dotRadius = float(0.04)
    const dotMask = float(1).sub(step(dotRadius, dist))

    const dotColor = vec3(0.267, 0.267, 0.267)
    dotMaterial.colorNode = dotColor
    dotMaterial.opacityNode = dotMask
    dotMaterial.mrtNode = mrt({
      output: dotColor,
      normal: vec3(0, 1, 0)
    })

    this.dotMesh = new Mesh(dotPlaneGeometry, dotMaterial)
    this.dotMesh.position.set(0, 0.015, 0)
    this.scene.add(this.dotMesh)

    // Coarse lot grid - centered at origin, lines at lot spacing intervals
    const lotGrid = new GridHelper(this.actualGridWidth, this.numLotsX, 0x888888, 0x888888)
    lotGrid.position.set(0, 0.02, 0)
    this.scene.add(lotGrid)
    this.lotGrid = lotGrid

    this.lotGrowth.createLotOutlines()
    this.enclosure.build()
  }

}
