import { GUI } from 'three/addons/libs/lil-gui.module.min.js'

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
      exposure: 1.0,
      envIntensity: 0.9,
      hdr: 'solitude_interior_1k.hdr',
      dirLight: 1.8,
      hemiLight: 0.3,
      shadowIntensity: 1.0,
      lightX: 50,
      lightY: 100,
      lightZ: 50,
      showHelper: false,
      hdrRotation: 180,
    },
    material: {
      roughness: 0.75,
      metalness: 0.35,
      clearcoat: 0.48,
      clearcoatRoughness: 0.47,
      iridescence: 0.21,
    },
    fx: {
      ao: true,
      aoScale: 2.7,
      aoRadius: 1,
      aoBlur: 0.3,
      aoIntensity: 0.95,
      vignette: true,
      fxaa: false,
    },
    debug: {
      view: 'final',
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

    // Action buttons
    gui.add({ regenCity: () => {
      demo.city.regenerate()
      demo.trails.generatePaths(30)
    } }, 'regenCity').name('Regen City')
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

    // City folder
    const cityFolder = gui.addFolder('City').close()
    cityFolder.add(allParams.scene, 'noiseScale', 0.005, 0.05, 0.005).name('Noise Scale').onChange((v) => {
      demo.city.noiseFrequency = v
      demo.city.recalculateNoise()
    })
    cityFolder.add(allParams.scene, 'noiseSubtract', 0, 0.5, 0.05).name('Noise Subtract').onChange((v) => {
      demo.city.noiseSubtract = v
      demo.city.recalculateHeights()
    })
    cityFolder.add(allParams.scene, 'noiseHeight', 0, 50, 1).name('Noise Height').onChange((v) => {
      demo.city.heightNoiseScale = v
      demo.city.recalculateHeights()
    })
    cityFolder.add(allParams.scene, 'randHeight', 0, 25, 1).name('Rand Height').onChange((v) => {
      demo.city.randHeightAmount = v
      demo.city.recalculateHeights()
    })
    cityFolder.add(allParams.scene, 'randHeightPower', 1, 10, 0.5).name('Rand Height Pow').onChange((v) => {
      demo.city.randHeightPower = v
      demo.city.recalculateHeights()
    })
    cityFolder.add(allParams.scene, 'centerFalloff', 0, 1, 0.05).name('Center Falloff').onChange((v) => {
      demo.city.centerFalloff = v
      demo.city.recalculateHeights()
    })
    cityFolder.add(allParams.scene, 'skipChance', 0, 1, 0.05).name('Skip Chance').onChange((v) => {
      demo.city.skipChance = v
      demo.city.recalculateVisibility()
    })

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
    fxFolder.add(allParams.fx, 'fxaa').name('FXAA').onChange((v) => {
      demo.fxaaEnabled.value = v ? 1 : 0
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

    // Material
    if (demo.city.towerMaterial) {
      demo.city.towerMaterial.roughness = params.material.roughness
      demo.city.towerMaterial.metalness = params.material.metalness
      demo.city.towerMaterial.clearcoat = params.material.clearcoat
      demo.city.towerMaterial.clearcoatRoughness = params.material.clearcoatRoughness
      demo.city.towerMaterial.iridescence = params.material.iridescence
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
    demo.fxaaEnabled.value = params.fx.fxaa ? 1 : 0

    // Camera
    demo.perspCamera.fov = params.camera.fov
    demo.perspCamera.updateProjectionMatrix()
  }
}
