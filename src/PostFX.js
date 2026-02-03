import { PostProcessing } from 'three/webgpu'
import {
  pass,
  output,
  mrt,
  normalView,
  viewportUV,
  clamp,
  uniform,
  select,
  mix,
  float,
  vec3,
  sub,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera

    this.postProcessing = new PostProcessing(renderer)

    // Effect toggle uniforms
    this.aoEnabled = uniform(1)
    this.vignetteEnabled = uniform(1)

    // Debug view: 0=final, 1=color, 2=depth, 3=normal, 4=AO
    this.debugView = uniform(0)

    // AO parameters
    this.aoBlurAmount = uniform(1)
    this.aoIntensity = uniform(1)

    // Fade to black (0 = black, 1 = fully visible)
    this.fadeOpacity = uniform(1)

    this._buildPipeline()
  }

  _buildPipeline() {
    const { scene, camera } = this

    // Scene pass with MRT for normal output
    const scenePass = pass(scene, camera)
    scenePass.setMRT(
      mrt({
        output: output,
        normal: normalView,
      })
    )

    const scenePassColor = scenePass.getTextureNode('output')
    const scenePassNormal = scenePass.getTextureNode('normal')
    const scenePassDepth = scenePass.getTextureNode('depth')

    // GTAO pass
    this.aoPass = ao(scenePassDepth, scenePassNormal, camera)
    this.aoPass.resolutionScale = 0.5 // Half-res AO for performance
    this.aoPass.distanceExponent.value = 1
    this.aoPass.distanceFallOff.value = 0.1
    this.aoPass.radius.value = 1.0
    this.aoPass.scale.value = 1.5
    this.aoPass.thickness.value = 1

    // AO texture for debug view
    const aoTexture = this.aoPass.getTextureNode()

    // Blur the AO to reduce banding artifacts
    const blurredAO = gaussianBlur(aoTexture, this.aoBlurAmount, 4) // sigma, radius

    // Soften AO: raise to power < 1 to reduce harshness, then blend
    const softenedAO = blurredAO.pow(0.5) // Square root makes it softer
    const blendedAO = mix(float(1), softenedAO, this.aoIntensity)
    const withAO = mix(scenePassColor, scenePassColor.mul(blendedAO), this.aoEnabled)

    // Vignette: darken edges toward black
    const vignetteFactor = float(1).sub(
      clamp(viewportUV.sub(0.5).length().mul(1.4), 0.0, 1.0).pow(1.5)
    )
    const vignetteMultiplier = mix(float(1), vignetteFactor, this.vignetteEnabled)
    const withVignette = mix(vec3(0, 0, 0), withAO, vignetteMultiplier)

    // Fade to black pass (final effect in chain)
    const fadeColor = vec3(0, 0, 0)
    const finalOutput = mix(fadeColor, withVignette, this.fadeOpacity)

    // Debug views
    const depthViz = vec3(scenePassDepth)
    const normalViz = scenePassNormal.mul(0.5).add(0.5)
    const aoViz = vec3(blurredAO)

    // Select output based on debug view
    const debugOutput = select(
      this.debugView.lessThan(0.5),
      finalOutput,
      select(
        this.debugView.lessThan(1.5),
        scenePassColor,
        select(
          this.debugView.lessThan(2.5),
          depthViz,
          select(this.debugView.lessThan(3.5), normalViz, aoViz)
        )
      )
    )

    this.postProcessing.outputNode = debugOutput
  }

  // Rebuild pipeline with new camera (e.g., after camera switch)
  setCamera(camera) {
    this.camera = camera
    this._buildPipeline()
  }

  render() {
    this.postProcessing.render()
  }
}
