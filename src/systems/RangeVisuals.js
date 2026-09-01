import { Mesh, RingGeometry, MeshBasicNodeMaterial, Vector2, Color } from 'three/webgpu'
import { isTurret, isPathGenerator, isShield, shieldRadiusCells, shieldCharges } from '../blockTypes.js'
import { Buffs } from '../buffs.js'
import { SHIELD_LINE } from '../palette.js'
import { fxMaterial, glow } from '../fx.js'


/**
 * A pool of flat ground rings (one per tower). Geometry is cached per radius
 * bucket and NEVER disposed; when a tower's radius changes the mesh is rebuilt
 * (swapping a live mesh's .geometry triggers a WebGPU setIndexBuffer crash).
 */
class RingLayer {
  constructor(scene, makeMaterial, radiusFor, { thickness = 0.12, y = 0.07 } = {}) {
    this.scene = scene
    this.makeMaterial = makeMaterial // () => material (one per mesh, reused)
    this.radiusFor = radiusFor // (numFloors) => world radius
    this.thickness = thickness
    this.y = y
    this.meshes = new Map() // tower -> Mesh
    this.geos = new Map() // numFloors -> RingGeometry
  }

  /**
   * Throw away the cached ring geometry.
   *
   * The cache is keyed on floor count alone, which is right while the only thing
   * that decides a radius IS the floor count - but a power-up can widen a shield
   * or lengthen a generator's reach without any tower changing height, and then
   * every cached ring is the wrong size and nothing would ever rebuild it.
   */
  invalidate() {
    for (const g of this.geos.values()) g.dispose()
    this.geos.clear()
  }

  geoFor(numFloors) {
    let g = this.geos.get(numFloors)
    if (!g) {
      const r = this.radiusFor(numFloors)
      g = new RingGeometry(r - this.thickness / 2, r + this.thickness / 2, 64)
      this.geos.set(numFloors, g)
    }
    return g
  }

  /** Place/update a tower's ring at world (x,z); returns the mesh for tweaks. */
  place(tower, x, z) {
    const geo = this.geoFor(tower.numFloors)
    let m = this.meshes.get(tower)
    if (!m || m.geometry !== geo) {
      const mat = m ? m.material : this.makeMaterial()
      if (m) this.scene.remove(m)
      m = glow(new Mesh(geo, mat))
      m.rotation.x = -Math.PI / 2
      m.renderOrder = -1
      this.scene.add(m)
      this.meshes.set(tower, m)
    }
    m.position.set(x, this.y, z)
    return m
  }

  hideUnseen(seen) {
    for (const [t, m] of this.meshes) if (!seen.has(t)) m.visible = false
  }
}

/**
 * RangeVisuals - ground rings showing zones of control (path generators) and
 * turret firing range, plus the turret-circle data for the coverage glow.
 */
export class RangeVisuals {
  constructor(city) {
    this.city = city
    this.showTurretRanges = false // turret rings hidden; the coverage glow shows range
    this._zc = new Vector2()

    this.zoc = new RingLayer(
      city.scene,
      () => fxMaterial(new MeshBasicNodeMaterial({ opacity: 0.6 })),
      // Link reach, in world units. Two path generators connect when the gap
      // between their centres is less than (a.numFloors + b.numFloors) * 2
      // CELLS - two cells per floor - so a generator's own half of that is
      // numFloors * 2 cells. Drawn at exactly that, so two rings touching is
      // precisely the moment the link forms.
      (n) => (n * 2 + Buffs.supportReach) * city.cellUnit,
      { thickness: 0.15, y: 0.06 }
    )
    // Shields draw a hard, solid line: a barrier is a thing with a definite
    // edge you either crossed or didn't, and the soft screen-space glow this
    // replaced said "area of influence", which is the wrong idea entirely.
    this.shield = new RingLayer(
      city.scene,
      () => fxMaterial(new MeshBasicNodeMaterial({
        color: new Color(SHIELD_LINE), opacity: 0.95,
      })),
      (n) => shieldRadiusCells(n) * city.cellUnit,
      { thickness: 0.16, y: 0.05 }
    )
    this.range = new RingLayer(
      city.scene,
      () => fxMaterial(new MeshBasicNodeMaterial({ color: 0xffffff, opacity: 0.4 })),
      (n) => (n * 2 + 1) * city.cellUnit,
      { thickness: 0.12, y: 0.07 }
    )
  }

  /** Drop cached ring geometry on every layer - call after a buff changes. */
  invalidate() {
    this.zoc.invalidate()
    this.shield.invalidate()
    this.range.invalidate()
  }

  refresh() {
    this.updateZocCircles()
    this.updateTurretRanges()
    this.updateShieldRings()
  }

  /** One solid ring per shield that still has charges; a spent one goes dark. */
  updateShieldRings() {
    const city = this.city
    const seen = new Set()
    for (const t of city.towers) {
      if (!t.visible || !isShield(t) || t.numFloors < 1) continue
      if (shieldCharges(t) <= 0) continue
      seen.add(t)
      t.box.getCenter(this._zc)
      const m = this.shield.place(t, this._zc.x + city.gridOffsetX, this._zc.y + city.gridOffsetZ)
      m.visible = true
    }
    this.shield.hideUnseen(seen)
  }

  /** One accent disc per path generator, sized to its zone of control. */
  updateZocCircles() {
    const city = this.city
    const seen = new Set()
    for (const t of city.towers) {
      if (!t.visible || !isPathGenerator(t) || t.numFloors < 1) continue
      seen.add(t)
      t.box.getCenter(this._zc)
      const m = this.zoc.place(t, this._zc.x + city.gridOffsetX, this._zc.y + city.gridOffsetZ)
      m.material.color.copy(city.accentColors[t.colorIndex])
      m.visible = true
    }
    this.zoc.hideUnseen(seen)
  }

  /** One ring per turret showing firing range ((numFloors + 1) cells). */
  updateTurretRanges() {
    const city = this.city
    const seen = new Set()
    for (const t of city.towers) {
      if (!t.visible || !isTurret(t)) continue
      seen.add(t)
      t.box.getCenter(this._zc)
      const m = this.range.place(t, this._zc.x + city.gridOffsetX, this._zc.y + city.gridOffsetZ)
      m.visible = this.showTurretRanges
    }
    this.range.hideUnseen(seen)
  }

  /** World centres + range radii of every visible turret (for the coverage glow). */
  getTurretCircles(out = []) {
    const city = this.city
    out.length = 0
    for (const t of city.towers) {
      if (!t.visible || !isTurret(t)) continue
      t.box.getCenter(this._zc)
      out.push({
        x: this._zc.x + city.gridOffsetX,
        z: this._zc.y + city.gridOffsetZ,
        r: (t.numFloors * 2 + 1) * city.cellUnit,
      })
    }
    return out
  }
}
