import { GUI } from 'three/addons/libs/lil-gui.module.min.js'
import { Sounds } from './lib/Sounds.js'
import { TileGeometry } from './Tiles.js'

export class GUIManager {
  constructor(demo) {
    this.demo = demo
    this.gui = null
    this.fovController = null
  }

  // Default params - single source of truth
  static defaultParams = {
    camera: {
      perspective: true,
      fov: 20,
    },
    scene: {
      noiseScale: 0.015,
      noiseSubtract: 0.15,
      noiseHeight: 27,
      randHeight: 5,
      randHeightPower: 6.5,
      centerFalloff: 1,
      skipChance: 0.1,
    },
    lighting: {
      exposure: 1.7,
      envIntensity: 0.95,
      hdr: 'venice_sunset_1k.hdr',
      dirLight: 2.15,
      hemiLight: 0.25,
      shadowIntensity: 1.0,
      lightX: 50,
      lightY: 100,
      lightZ: 50,
      showHelper: false,
      hdrRotation: 191,
      hdrTilt: -90,
    },
    material: {
      color: '#ffffff',
      roughness: 1,
      metalness: 0.03,
      clearcoat: 0.53,
      clearcoatRoughness: 0,
      iridescence: 0.21,
      useBlenderTexture: true,
    },
    fx: {
      ao: true,
      aoScale: 2.7,
      aoRadius: 1,
      aoBlur: 0.3,
      aoIntensity: 0.95,
      vignette: true,
      trails: true,
      dots: true,
      debris: true,
    },
    debug: {
      view: 'final',
      originHelper: true,
      debugCam: true,
    },
    renderer: {
      dpr: 1, // Will be set dynamically based on device
    },
    roads: {
      cumulativeWeights: false,
      maxTiles: 150,
      layers: 1,
      useWFC: true,
      wfcSeed: 0,
    },
  }

  init() {
    const { demo } = this
    const gui = new GUI()
    this.gui = gui

    // Store params on demo for single source of truth
    const allParams = demo.params = JSON.parse(JSON.stringify(GUIManager.defaultParams))

    // Top-level controls (no folder)
    gui.add(allParams.camera, 'perspective').name('Perspective Cam').onChange((v) => {
      demo.switchCamera(v)
    })
    this.fovController = gui.add(allParams.camera, 'fov', 20, 90, 1).name('FOV').onChange((v) => {
      demo.perspCamera.fov = v
      demo.perspCamera.updateProjectionMatrix()
    })

    // Debug view
    const viewMap = { final: 0, color: 1, depth: 2, normal: 3, ao: 4 }
    gui.add(allParams.debug, 'view', Object.keys(viewMap)).name('Debug View').onChange((v) => {
      demo.debugView.value = viewMap[v]
    })

    // Visual toggles at top level
    gui.add(allParams.fx, 'trails').name('Trails').onChange((v) => {
      if (demo.trails && demo.trails.meshes) {
        for (const mesh of demo.trails.meshes) mesh.visible = v
      }
    })
    gui.add(allParams.fx, 'dots').name('Dots').onChange((v) => {
      if (demo.dotMesh) demo.dotMesh.visible = v
    })
    gui.add(allParams.fx, 'debris').name('Debris').onChange((v) => {
      if (demo.city.debris) demo.city.debris.enabled = v
    })
    gui.add(allParams.debug, 'originHelper').name('Origin Helper').onChange((v) => {
      if (demo.axesHelper) demo.axesHelper.visible = v
    })
    gui.add(allParams.debug, 'debugCam').name('Debug Cam').onChange((v) => {
      demo.controls.maxPolarAngle = v ? Math.PI : 1.53
      demo.controls.minDistance = v ? 0 : 40
      demo.controls.maxDistance = v ? Infinity : 470
    })

    // DPR dropdown (default 1)
    allParams.renderer.dpr = 1
    gui.add(allParams.renderer, 'dpr', [1, 1.5, 2]).name('DPR').onChange((v) => {
      demo.renderer.setPixelRatio(v)
      demo.onResize()
    })

    // Action buttons
    gui.add({ regenCity: () => {
      demo.city.regenerate()
      if (demo.trails) demo.trails.generatePaths(30)
    } }, 'regenCity').name('Regen City')
    gui.add({ replayBuild: () => {
      demo.city.recalculateHeights()
      demo.city.recalculateVisibility()
      demo.postFX.fadeOpacity.value = 0
      demo.fadeIn(1000)
      Sounds.play('intro')
      demo.city.startIntroAnimation(demo.camera, demo.controls, 4)
    } }, 'replayBuild').name('Replay Build')
    gui.add({ exportPNG: () => demo.exportPNG() }, 'exportPNG').name('Export PNG')

    gui.add({
      copyState: () => {
        const exportData = {
          ...allParams,
          cameraState: {
            position: { x: demo.camera.position.x, y: demo.camera.position.y, z: demo.camera.position.z },
            target: { x: demo.controls.target.x, y: demo.controls.target.y, z: demo.controls.target.z },
          }
        }
        const json = JSON.stringify(exportData, null, 2)
        navigator.clipboard.writeText(json)
        console.log('GUI State copied:\n', json)
      }
    }, 'copyState').name('Copy GUI State')
    gui.add({
      logControls: () => {
        const c = demo.controls
        const cam = demo.camera
        console.log('OrbitControls State:')
        console.log('  camera.position:', cam.position.x.toFixed(3), cam.position.y.toFixed(3), cam.position.z.toFixed(3))
        console.log('  target:', c.target.x.toFixed(3), c.target.y.toFixed(3), c.target.z.toFixed(3))
        console.log('  distance:', cam.position.distanceTo(c.target).toFixed(3))
        console.log('  polar angle (vertical):', c.getPolarAngle().toFixed(3), 'rad =', (c.getPolarAngle() * 180 / Math.PI).toFixed(1) + '°')
        console.log('  azimuth angle (horizontal):', c.getAzimuthalAngle().toFixed(3), 'rad =', (c.getAzimuthalAngle() * 180 / Math.PI).toFixed(1) + '°')
      }
    }, 'logControls').name('Log Orbit State')

    // Roads folder
    const roadsFolder = gui.addFolder('Roads').close()
    roadsFolder.add(allParams.roads, 'layers', 1, 5, 1).name('Layers').onChange((v) => {
      demo.city.numLayers = v
    })
    roadsFolder.add(allParams.roads, 'useWFC').name('Use WFC')
    roadsFolder.add(allParams.roads, 'wfcSeed', 0, 9999, 1).name('WFC Seed')
    roadsFolder.add(allParams.roads, 'cumulativeWeights').name('Cumulative Weights')
    roadsFolder.add(allParams.roads, 'maxTiles', 50, 300, 10).name('Max Tiles')

    // Lights folder
    const lightsFolder = gui.addFolder('Lights').close()
    const hdrOptions = [
      'studio_small_05_2k.hdr',
      'studio_small_08_2k.hdr',
      'photo_studio_01_1k.hdr',
      'royal_esplanade_1k.hdr',
      'solitude_interior_1k.hdr',
      'venice_sunset_1k.hdr',
    ]
    lightsFolder.add(allParams.lighting, 'hdr', hdrOptions).name('HDR').onChange((v) => {
      demo.lighting.loadHDR(v)
    })
    lightsFolder.add(allParams.lighting, 'hdrRotation', 0, 360, 1).name('HDR Rotation').onChange((v) => {
      const rad = v * Math.PI / 180
      demo.scene.backgroundRotation.y = rad
      if (demo.city.envRotation) {
        demo.city.envRotation.value = rad
      }
    })
    lightsFolder.add(allParams.lighting, 'hdrTilt', -90, 90, 1).name('HDR Tilt').onChange((v) => {
      const rad = v * Math.PI / 180
      demo.scene.backgroundRotation.x = rad
      if (demo.city.envRotationX) {
        demo.city.envRotationX.value = rad
      }
    })
    lightsFolder.add(allParams.lighting, 'exposure', 0, 2, 0.05).name('Exposure').onChange((v) => {
      demo.renderer.toneMappingExposure = v
    })
    lightsFolder.add(allParams.lighting, 'envIntensity', 0, 2, 0.05).name('Env Intensity').onChange((v) => {
      demo.scene.environmentIntensity = v
    })
    lightsFolder.add(allParams.lighting, 'dirLight', 0, 5, 0.05).name('Dir Light').onChange((v) => {
      if (demo.lighting.dirLight) demo.lighting.dirLight.intensity = v
    })
    lightsFolder.add(allParams.lighting, 'hemiLight', 0, 5, 0.05).name('Hemi Light').onChange((v) => {
      if (demo.lighting.hemiLight) demo.lighting.hemiLight.intensity = v
    })
    lightsFolder.add(allParams.lighting, 'shadowIntensity', 0, 1, 0.05).name('Shadow Intensity').onChange((v) => {
      if (demo.lighting.dirLight) demo.lighting.dirLight.shadow.intensity = v
    })
    lightsFolder.add(allParams.lighting, 'lightX', -100, 100, 5).name('Light X').onChange((v) => {
      if (demo.lighting.dirLightOffset) {
        demo.lighting.dirLightOffset.x = v
        demo.lighting.updateShadowFrustum()
      }
    })
    lightsFolder.add(allParams.lighting, 'lightY', 20, 200, 5).name('Light Y').onChange((v) => {
      if (demo.lighting.dirLightOffset) {
        demo.lighting.dirLightOffset.y = v
        demo.lighting.updateShadowFrustum()
      }
    })
    lightsFolder.add(allParams.lighting, 'lightZ', -100, 100, 5).name('Light Z').onChange((v) => {
      if (demo.lighting.dirLightOffset) {
        demo.lighting.dirLightOffset.z = v
        demo.lighting.updateShadowFrustum()
      }
    })
    lightsFolder.add(allParams.lighting, 'showHelper').name('Show Helper').onChange((v) => {
      if (demo.lighting.dirLightHelper) demo.lighting.dirLightHelper.visible = v
    })

    // Material folder
    const matFolder = gui.addFolder('Material').close()
    matFolder.addColor(allParams.material, 'color').name('Color').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.color.set(v)
    })
    matFolder.add(allParams.material, 'roughness', 0, 1, 0.01).name('Roughness').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.roughness = v
    })
    matFolder.add(allParams.material, 'metalness', 0, 1, 0.01).name('Metalness').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.metalness = v
    })
    matFolder.add(allParams.material, 'clearcoat', 0, 1, 0.01).name('Clearcoat').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.clearcoat = v
    })
    matFolder.add(allParams.material, 'clearcoatRoughness', 0, 1, 0.01).name('Clearcoat Rough').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.clearcoatRoughness = v
    })
    matFolder.add(allParams.material, 'iridescence', 0, 1, 0.01).name('Iridescence').onChange((v) => {
      if (demo.city.towerMaterial) demo.city.towerMaterial.iridescence = v
    })
    matFolder.add(allParams.material, 'useBlenderTexture').name('Blender Texture').onChange((v) => {
      if (demo.city.towerMaterial) {
        demo.city.towerMaterial.map = v ? TileGeometry.roadTexture : null
        demo.city.towerMaterial.needsUpdate = true
      }
    })

    // Effects folder
    const fxFolder = gui.addFolder('Post Processing').close()
    fxFolder.add(allParams.fx, 'ao').name('AO').onChange((v) => {
      demo.aoEnabled.value = v ? 1 : 0
    })
    fxFolder.add(allParams.fx, 'aoScale', 0, 5, 0.1).name('AO Scale').onChange((v) => {
      if (demo.aoPass) demo.aoPass.scale.value = v
    })
    fxFolder.add(allParams.fx, 'aoRadius', 0.01, 2, 0.01).name('AO Radius').onChange((v) => {
      if (demo.aoPass) demo.aoPass.radius.value = v
    })
    fxFolder.add(allParams.fx, 'aoBlur', 0, 0.5, 0.01).name('AO Blur').onChange((v) => {
      if (demo.aoBlurAmount) demo.aoBlurAmount.value = v
    })
    fxFolder.add(allParams.fx, 'aoIntensity', 0, 1, 0.05).name('AO Intensity').onChange((v) => {
      demo.aoIntensity.value = v
    })
    fxFolder.add(allParams.fx, 'vignette').name('Vignette').onChange((v) => {
      demo.vignetteEnabled.value = v ? 1 : 0
    })

    return allParams
  }

  // Apply all GUI params to scene objects (called after init)
  applyParams() {
    const { demo } = this
    const { params } = demo

    // Lighting
    demo.renderer.toneMappingExposure = params.lighting.exposure
    demo.scene.environmentIntensity = params.lighting.envIntensity
    if (demo.lighting.dirLight) {
      demo.lighting.dirLight.intensity = params.lighting.dirLight
      demo.lighting.dirLight.shadow.intensity = params.lighting.shadowIntensity
    }
    if (demo.lighting.hemiLight) demo.lighting.hemiLight.intensity = params.lighting.hemiLight
    if (demo.lighting.dirLightOffset) {
      demo.lighting.dirLightOffset.x = params.lighting.lightX
      demo.lighting.dirLightOffset.y = params.lighting.lightY
      demo.lighting.dirLightOffset.z = params.lighting.lightZ
      demo.lighting.updateShadowFrustum()
    }
    if (demo.lighting.dirLightHelper) demo.lighting.dirLightHelper.visible = params.lighting.showHelper
    const hdrRad = params.lighting.hdrRotation * Math.PI / 180
    demo.scene.backgroundRotation.y = hdrRad
    if (demo.city.envRotation) {
      demo.city.envRotation.value = hdrRad
    }
    const hdrTiltRad = params.lighting.hdrTilt * Math.PI / 180
    demo.scene.backgroundRotation.x = hdrTiltRad
    if (demo.city.envRotationX) {
      demo.city.envRotationX.value = hdrTiltRad
    }

    // Material
    if (demo.city.towerMaterial) {
      demo.city.towerMaterial.color.set(params.material.color)
      demo.city.towerMaterial.roughness = params.material.roughness
      demo.city.towerMaterial.metalness = params.material.metalness
      demo.city.towerMaterial.clearcoat = params.material.clearcoat
      demo.city.towerMaterial.clearcoatRoughness = params.material.clearcoatRoughness
      demo.city.towerMaterial.iridescence = params.material.iridescence
      demo.city.towerMaterial.map = params.material.useBlenderTexture ? TileGeometry.roadTexture : null
      demo.city.towerMaterial.needsUpdate = true
    }

    // Post processing
    demo.aoEnabled.value = params.fx.ao ? 1 : 0
    if (demo.aoPass) {
      demo.aoPass.scale.value = params.fx.aoScale
      demo.aoPass.radius.value = params.fx.aoRadius
    }
    if (demo.aoBlurAmount) demo.aoBlurAmount.value = params.fx.aoBlur
    demo.aoIntensity.value = params.fx.aoIntensity
    demo.vignetteEnabled.value = params.fx.vignette ? 1 : 0

    // Camera
    demo.perspCamera.fov = params.camera.fov
    demo.perspCamera.updateProjectionMatrix()
    demo.controls.maxPolarAngle = params.debug.debugCam ? Math.PI : 1.53
    demo.controls.minDistance = params.debug.debugCam ? 0 : 40
    demo.controls.maxDistance = params.debug.debugCam ? Infinity : 470
    if (demo.axesHelper) demo.axesHelper.visible = params.debug.originHelper

    // Renderer
    demo.renderer.setPixelRatio(params.renderer.dpr)
  }
}
