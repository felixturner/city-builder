import { MathUtils, Color } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { Tower } from '../Tower.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, isTurret, isGenerator, roofGeomIndex } from '../blockTypes.js'

const KING_COLOR = new Color(0xff7000) // bright orange central king piece

/**
 * TowerRenderer - runtime tower visual state on the shared BatchedMesh: accent
 * coloring of special towers, distance-based visibility, in-place reroll of a
 * tower's type/colors, and the destroy lifecycle. Operates on the mesh/state
 * held by City; one-time mesh construction stays in City.initTowers().
 */
export class TowerRenderer {
  constructor(city) {
    this.city = city
    this.turretColor = new Color(0xbbbbbb) // grey shade for turret tower blocks
  }

  /**
   * Accent-colour special towers: path generators (plus) and adjacency
   * generators (holes) go fully accent; turrets get a stashed laser colour.
   */
  applyLitTowers() {
    const city = this.city
    for (const tower of city.towers) {
      tower.isLit = tower.typeTop === TopType.PATH_GENERATOR
      if (tower.isLit) {
        const accent = city.accentColors[tower.colorIndex]
        tower.litColor = accent.clone()
        city.setTowerColor(tower, accent)
      } else if (tower.typeTop === TopType.ADJ_GENERATOR) {
        const accent = city.accentColors[tower.colorIndex]
        tower.litColor = accent.clone()
        tower.baseColor = accent.clone()
        tower.topColor = accent.clone()
        city.setTowerColor(tower, accent)
      } else {
        tower.litColor = null
        if (isTurret(tower)) {
          this.colorTurretTower(tower)
          city.setTowerColor(tower, tower.baseColor)
        }
      }
    }
  }

  /** Turrets keep grey blocks but stash the lot accent on laserColor. */
  colorTurretTower(tower) {
    tower.laserColor = this.city.accentColors[tower.colorIndex].clone()
    tower.baseColor = this.turretColor
    tower.topColor = this.turretColor
  }

  /** Hide towers based on distance-weighted skip chance (dormant/empty stay hidden). */
  recalculateVisibility() {
    const city = this.city
    if (!city.towerMesh) return
    const gridCenterX = city.actualGridWidth / 2
    const gridCenterY = city.actualGridHeight / 2
    const maxDist = Math.hypot(gridCenterX, gridCenterY)

    for (const tower of city.towers) {
      if (tower.dormant || tower.empty) { tower.visible = false; continue }
      const center = tower.box.getCenter(city.towerCenter)
      const dist = Math.hypot(center.x - gridCenterX, center.y - gridCenterY)
      const distFactor = Math.pow(dist / maxDist, 2) // 0 centre, 1 corner
      const effectiveSkipChance = city.skipChance + distFactor * 1.2
      tower.visible = tower.skipFactor >= effectiveSkipChance
    }
    city.updateMatrices() // visibility applied here based on tower.visible
  }

  /**
   * Re-randomize a tower's tile in place after it's destroyed. Footprint stays;
   * rolls a fresh top type (respecting footprint constraints) + new colours, and
   * points the instances at the new geometries.
   */
  rerollTower(tower) {
    // Rectangular tops only (no quart). Pick from the rect set, then demote
    // footprint-constraint violators to a plain grey rect.
    const pool = [TopType.SQUARE, TopType.ADJ_GENERATOR, TopType.PEG_TURRET, TopType.DIVOT_TURRET, TopType.PATH_GENERATOR]
    tower.typeTop = pool[MathUtils.randInt(0, pool.length - 1)]
    const size = tower.box.getSize(this.city.towerSize)
    const w = Math.round(size.x / this.city.cellUnit)
    const h = Math.round(size.y / this.city.cellUnit)
    // Generators only on squares, turrets only on 1x1 (capped 2/lot).
    if (tower.typeTop === TopType.PATH_GENERATOR && w !== h) tower.typeTop = TopType.SQUARE
    if (isTurret(tower) && (!(w === 1 && h === 1) || this.countLotTurrets(tower) >= 2)) {
      tower.typeTop = TopType.SQUARE
    }
    if (tower.typeTop === TopType.ADJ_GENERATOR && w !== h) tower.typeTop = TopType.SQUARE
    tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
    this.applyTypeVisuals(tower)
  }

  /**
   * Apply visuals for a placed tile. Tetromino walls point their instances at
   * the merged tetromino body/roof geometry and colour grey; everything else
   * falls through to the rectangular type path.
   */
  applyTileVisuals(tower) {
    if (!tower.tetro) { this.applyTypeVisuals(tower); return }
    const city = this.city
    const mesh = city.towerMesh
    const ids = city.tetroGeom.get(`${tower.tetro.name}:${tower.tetro.rot}`)
    for (const idx of tower.floorInstances) mesh.setGeometryIdAt(idx, ids.bodyId)
    mesh.setGeometryIdAt(tower.roofInstance, ids.roofId)
    tower.isLit = false
    tower.litColor = null
    tower.laserColor = null
    tower.topColor = Tower.COLORS[tower.topColorIndex]
    tower.baseColor = tower.topColor // under-blocks match the top
    for (const idx of tower.floorInstances) mesh.setColorAt(idx, tower.baseColor)
    mesh.setColorAt(tower.roofInstance, tower.topColor)
  }

  /**
   * Point a tower's instances at the geometries for its current typeTop and
   * colour it by type (path/adj generators -> accent, turret -> grey + laser
   * colour, grey -> base/top). Shared by reroll and palette placement.
   */
  applyTypeVisuals(tower) {
    const city = this.city
    const mesh = city.towerMesh
    const g = roofGeomIndex(tower.typeTop) // rendered top geometry (role != geom)
    tower.typeBottom = BlockGeometry.topToBottom.get(g)

    for (const idx of tower.floorInstances) mesh.setGeometryIdAt(idx, city.geomIds[tower.typeBottom])
    mesh.setGeometryIdAt(tower.roofInstance, city.geomIds[g])

    if (tower.king) {
      tower.isLit = false
      tower.litColor = null
      tower.baseColor = KING_COLOR.clone()
      tower.topColor = KING_COLOR.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, tower.baseColor)
      mesh.setColorAt(tower.roofInstance, tower.topColor)
      return
    }

    tower.isLit = tower.typeTop === TopType.PATH_GENERATOR
    if (isGenerator(tower)) {
      // Generators (path / adj / enclosure): whole tower the accent (litColor glows).
      const accent = city.accentColors[tower.colorIndex]
      tower.litColor = accent.clone()
      tower.baseColor = accent.clone()
      tower.topColor = accent.clone()
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, accent)
      mesh.setColorAt(tower.roofInstance, accent)
    } else {
      tower.litColor = null
      if (isTurret(tower)) {
        this.colorTurretTower(tower)
      } else {
        tower.laserColor = null
        tower.baseColor = Tower.BASE_COLOR
        tower.topColor = Tower.COLORS[tower.topColorIndex]
      }
      for (const idx of tower.floorInstances) mesh.setColorAt(idx, tower.baseColor)
      mesh.setColorAt(tower.roofInstance, tower.topColor)
    }
  }

  /**
   * Knock a tower down one floor, or destroy a level-0 tower. Returns the new
   * floor count. Destroyed tiles free their cell and vanish (no empty slots).
   */
  damageTower(tower) {
    const city = this.city
    if (!tower || !tower.visible) return 0

    const center = tower.box.getCenter(city.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * city.floorHeight
    const color = tower.litColor || tower.baseColor
    city.debris.spawn(center.x + city.gridOffsetX, y, center.y + city.gridOffsetZ, 0.8, color, 10)
    Sounds.play('break2', 1.0, 0.2)

    if (tower.numFloors >= 1) {
      tower.numFloors -= 1
      city.onTowerChanged(tower)
      if (tower.king && tower.numFloors === 0) city.triggerGameOver()
      return tower.numFloors
    }
    // The king is never demolished - knocking its last floor ends the game.
    if (tower.king) { city.triggerGameOver(); return 0 }
    // Destroyed at level 0: free its cell(s) and remove it (debris already spawned).
    city.demolishTower(tower)
    return 0
  }

  /** Count turret towers in a tower's lot, excluding itself. */
  countLotTurrets(tower) {
    const lot = this.city.lots?.[tower.lotY]?.[tower.lotX]
    if (!lot) return 0
    let n = 0
    for (const t of lot.towers) {
      if (t !== tower && isTurret(t)) n++
    }
    return n
  }
}
