import { MathUtils, Color, LineSegments, LineBasicNodeMaterial, BufferGeometry, Float32BufferAttribute } from 'three/webgpu'
import { Sounds } from '../lib/Sounds.js'
import { Tower } from '../Tower.js'
import { BlockGeometry } from '../lib/BlockGeometry.js'
import { TopType, isTurret } from '../blockTypes.js'

/**
 * TowerRenderer - runtime tower visual state on the shared BatchedMesh: accent
 * coloring of special towers, distance-based visibility, in-place reroll of a
 * tower's type/colors, and the destroy -> empty-tower (grey outline) lifecycle.
 * Operates on the mesh/state held by City; one-time mesh construction stays in
 * City.initTowers().
 */
export class TowerRenderer {
  constructor(city) {
    this.city = city
    this.turretColor = new Color(0xbbbbbb) // grey shade for turret tower blocks
    this.emptyTowerOutlines = new Map() // tower -> grey floor-outline mesh
    this.emptyTowerMat = null
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
    tower.typeTop = MathUtils.randInt(0, 5)
    const size = tower.box.getSize(this.city.towerSize)
    const w = Math.round(size.x / this.city.cellUnit)
    const h = Math.round(size.y / this.city.cellUnit)
    // Footprint constraints: generators only on squares, turrets only on 1x1
    // (capped 2/lot), holes only on squares; demote violators to plain.
    if (tower.typeTop === TopType.PATH_GENERATOR && w !== h) tower.typeTop = MathUtils.randInt(0, 2)
    if (isTurret(tower) && (!(w === 1 && h === 1) || this.countLotTurrets(tower) >= 2)) {
      tower.typeTop = MathUtils.randInt(0, 2)
    }
    if (tower.typeTop === TopType.ADJ_GENERATOR && w !== h) tower.typeTop = MathUtils.randInt(0, 1)
    tower.setTopColorIndex(MathUtils.randInt(0, Tower.COLORS.length - 1))
    this.applyTypeVisuals(tower)
  }

  /**
   * Place a specific tile (from the palette) into an empty slot: set its type +
   * colour, reveal it as a level-0 block, and notify. The slot footprint must
   * already match the tile (checked by the palette).
   */
  placeTile(tower, typeTop, colorIndex, topColorIndex) {
    const city = this.city
    tower.emptyTower = false
    tower.visible = true
    tower.numFloors = 0
    tower.typeTop = typeTop
    tower.colorIndex = colorIndex
    tower.setTopColorIndex(topColorIndex)
    this.applyTypeVisuals(tower)
    this.clearEmptyTowerOutline(tower)
    city.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15)
    city.onTowerChanged(tower)
  }

  /**
   * Point a tower's instances at the geometries for its current typeTop and
   * colour it by type (path/adj generators -> accent, turret -> grey + laser
   * colour, grey -> base/top). Shared by reroll and palette placement.
   */
  applyTypeVisuals(tower) {
    const city = this.city
    const mesh = city.towerMesh
    tower.typeBottom = BlockGeometry.topToBottom.get(tower.typeTop)

    for (const idx of tower.floorInstances) mesh.setGeometryIdAt(idx, city.geomIds[tower.typeBottom])
    mesh.setGeometryIdAt(tower.roofInstance, city.geomIds[tower.typeTop])

    tower.isLit = tower.typeTop === TopType.PATH_GENERATOR
    if (tower.isLit || tower.typeTop === TopType.ADJ_GENERATOR) {
      // Path + adjacency generators: whole tower the lot accent (litColor glows).
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
   * Knock a tower down one floor, or destroy a level-0 tower into an empty
   * (grey-outline) slot. Returns the new floor count.
   */
  damageTower(tower) {
    const city = this.city
    if (!tower || !tower.visible || tower.emptyTower) return 0

    const center = tower.box.getCenter(city.towerCenter)
    const y = Math.max(0.5, tower.numFloors - 0.5) * city.floorHeight
    const color = tower.litColor || tower.baseColor
    city.debris.spawn(center.x + city.gridOffsetX, y, center.y + city.gridOffsetZ, 0.8, color, 10)
    Sounds.play('break2', 1.0, 0.2)

    if (tower.numFloors >= 1) {
      tower.numFloors -= 1
      city.onTowerChanged(tower)
      return tower.numFloors
    }
    // Destroyed: freely-placed tiles free their cell (debris already spawned
    // above); pre-built center-lot towers become a grey-outline empty slot.
    if (tower.placed) {
      city.freePlacedTower(tower)
      return 0
    }
    this.setEmptyTower(tower)
    city.onTowerChanged(tower)
    return 0
  }

  /** Convert a tower into an empty tower: all blocks gone, grey floor outline. */
  setEmptyTower(tower) {
    tower.emptyTower = true
    tower.numFloors = 0
    tower.visible = false
    this.city.updateTowerMatrices(tower) // hides every instance
    this.showEmptyTowerOutline(tower)
  }

  /** Regenerate a fresh random level-0 tile where an empty tower was. */
  regenEmptyTower(tower) {
    const city = this.city
    tower.emptyTower = false
    tower.visible = true
    tower.numFloors = 0
    this.rerollTower(tower)
    this.clearEmptyTowerOutline(tower)
    city.updateTowerMatrices(tower)
    Sounds.play('pop', 0.8, 0.15)
    city.onTowerChanged(tower)
  }

  /** Show (lazily building) the grey floor outline for an empty tower. */
  showEmptyTowerOutline(tower) {
    const city = this.city
    let o = this.emptyTowerOutlines.get(tower)
    if (!o) {
      if (!this.emptyTowerMat) {
        this.emptyTowerMat = new LineBasicNodeMaterial({ color: 0xffffff, depthTest: false })
      }
      const x0 = tower.box.min.x + city.gridOffsetX
      const z0 = tower.box.min.y + city.gridOffsetZ
      const x1 = tower.box.max.x + city.gridOffsetX
      const z1 = tower.box.max.y + city.gridOffsetZ
      const y = 0.08
      const geom = new BufferGeometry()
      geom.setAttribute('position', new Float32BufferAttribute([
        x0, y, z0, x1, y, z0,
        x1, y, z0, x1, y, z1,
        x1, y, z1, x0, y, z1,
        x0, y, z1, x0, y, z0,
      ], 3))
      o = new LineSegments(geom, this.emptyTowerMat)
      o.renderOrder = 3
      city.scene.add(o)
      this.emptyTowerOutlines.set(tower, o)
    }
    o.visible = true
  }

  clearEmptyTowerOutline(tower) {
    const o = this.emptyTowerOutlines.get(tower)
    if (o) o.visible = false
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
