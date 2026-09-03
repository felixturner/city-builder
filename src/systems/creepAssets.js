import {
  BoxGeometry, SphereGeometry, Color,
  MeshStandardNodeMaterial, MeshBasicNodeMaterial,
} from 'three/webgpu'
import { CREEP, WARN, SHIELD_LINE } from '../palette.js'
import { NO_AO_MRT } from '../fx.js'

/** Hot orange, brighter than any creep body, so a hit reads against a clump. */
const HIT_FLASH_COLOR = CREEP.hitFlash

/**
 * Every mesh and material a creep is made of, in one object.
 *
 * These are shared by TYPE - one material per kind of creep, not one per creep -
 * so a wave of forty costs four materials. That is also why a hit flash swaps
 * the reference on the individual creep rather than tinting the material: doing
 * it in place would light up every creep of that type at once.
 *
 * Lifted out of the Creeps constructor, which was 233 lines of which seventy
 * were this. The field names are unchanged and Creeps assigns them onto itself,
 * so `this.smasherMat` still reads the same everywhere it is used - what moved
 * is only where the colours and roughness values are written down.
 */
export function createCreepAssets() {
  return {
    geo: new BoxGeometry(2, 2, 2),
    // Two kinds of creep, and the colour is the tell:
    //   SMASHERS (near-black) bulldoze - a straight line at the king, attacking
    //     whatever stands on it, so your walls are something they chew through.
    //   SEEKERS (purple) read the flow field - they thread the gaps you left to
    //     reach the king, and peel off to a generator if you have sealed it.
    // Half a wave is each, and every giant is a smasher.
    smasherMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.eye),
      roughness: 0.55,
      metalness: 0,
    }),
    seekerMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.spawnMarker),
      roughness: 0.55,
      metalness: 0,
    }),
    // F-mode type dot above each creep: red = smasher, green = seeker.
    // depthTest off so it stays visible even when the creep is behind a tower.
    dotGeo: new SphereGeometry(0.34, 12, 8),
    dotSmasherMat: new MeshBasicNodeMaterial({ color: new Color(WARN.flowBlocked), depthTest: false }),
    dotSeekerMat: new MeshBasicNodeMaterial({ color: new Color(WARN.flowOk), depthTest: false }),

    // Laser creeps: stop at range and fire a turret-style beam at towers.
    laserMat: new MeshStandardNodeMaterial({ color: new Color(CREEP.laser), roughness: 0.4, metalness: 0.15 }),
    creepLaserColor: new Color(CREEP.laserBeam),
    // Shooter creeps read deep orange so they're distinguishable from marchers;
    // seeker shooters are a lighter orange (matching the body lightness rule).
    shooterSmasherMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.body),
      roughness: 0.5,
      metalness: 0,
    }),
    shooterSeekerMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.bodyLight),
      roughness: 0.5,
      metalness: 0,
    }),
    // Boss giants: a menacing dark red, much larger and tankier than any creep.
    giantMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.dark),
      roughness: 0.45,
      metalness: 0.1,
    }),
    // Little blocks shooters lob at towers.
    shotGeo: new BoxGeometry(0.55, 0.55, 0.55),
    shotMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.shot),
      emissive: new Color(CREEP.shotGlow),
      roughness: 0.4,
      metalness: 0,
    }),

    // Bomber creeps: fly across the map at altitude and drop bombs.
    bomberMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.bomber),
      emissive: new Color(CREEP.bomberGlow),
      roughness: 0.5,
      metalness: 0,
    }),
    // Bombs they drop (fall straight down, damage the tower they land on).
    bombGeo: new BoxGeometry(0.7, 0.7, 0.7),
    bombMat: new MeshStandardNodeMaterial({
      color: new Color(CREEP.bomb),
      emissive: new Color(CREEP.bombGlow),
      roughness: 0.4,
      metalness: 0,
    }),
  }
}


/**
 * The two flash materials a creep's mesh is swapped to when it is hit.
 *
 * Swapped rather than tinted: creeps share materials by type, so tinting one
 * would light up every creep of that type at once. Swapping the reference is
 * per-creep and allocates nothing.
 */
export function createFlashMaterials() {
    // One shared material for the burn flash. Creeps already share materials by
    // TYPE, so tinting a creep's own material would light up every creep of that
    // type at once; swapping the reference is per-creep and allocates nothing.
  const shieldFlashMat = new MeshStandardNodeMaterial({
      color: new Color(SHIELD_LINE),
      emissive: new Color(SHIELD_LINE).multiplyScalar(0.7),
      roughness: 0.4,
      metalness: 0,
    })
    // Both flash materials get drawn into the glow target, which has two colour
    // attachments - a material with no mrtNode writes one, and a pipeline whose
    // outputs don't cover the attachments takes the whole command buffer down.
  shieldFlashMat.mrtNode = NO_AO_MRT()
    // Ordinary damage flash: hot orange, bright enough to bloom. Creeps are near
    // black, so a hit had no visual tell at all beyond the stone thunk - you
    // could not see which of a dozen creeps your turrets were actually working
    // on. Emissive over 1 puts it on the glow layer's side of the threshold.
  const hitFlashMat = new MeshStandardNodeMaterial({
      color: new Color(HIT_FLASH_COLOR),
      emissive: new Color(HIT_FLASH_COLOR).multiplyScalar(1.4),
      roughness: 0.4,
      metalness: 0,
    })
  hitFlashMat.mrtNode = NO_AO_MRT()
  return { shieldFlashMat, hitFlashMat }
}
