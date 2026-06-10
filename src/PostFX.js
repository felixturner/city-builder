import {
  PostProcessing,
  Scene,
  Mesh,
  CircleGeometry,
  MeshBasicNodeMaterial,
  Color,
  RenderTarget,
  RGBAFormat,
} from 'three/webgpu'
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
  texture,
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

    // Turret coverage glow: light-blue gradient fading out from the edge of the
    // union of all turret range circles.
    this.coverageEnabled = uniform(1)
    this.coverageBlur = uniform(1.2) // how far the gradient reaches inward (small = thin edge)
    this.coverageStrength = uniform(0.6) // scales the gradient peak
    this.coverageOpacity = uniform(0.15) // safety cap on additive brightness
    this.coverageColor = uniform(new Color(0.55, 0.8, 1.0)) // light blue

    this._buildMaskScene()
    this._buildPipeline()
  }

  /**
   * A throwaway scene of flat white discs (one per turret) on the ground plane.
   * Rendered as its own pass so its union forms a coverage mask in screen space.
   */
  _buildMaskScene() {
    this.maskScene = new Scene()
    this.maskScene.background = new Color(0x000000)
    this.maskGeo = new CircleGeometry(1, 48) // unit disc, scaled per turret
    this.maskMat = new MeshBasicNodeMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
    })
    this.maskMeshes = []
    this._growMaskPool(48)

    // Quarter-res target the mask is rendered into each frame (manual pass,
    // then sampled in the pipeline via texture()). Low-res is fine - it's
    // blurred into a soft glow anyway, and it's cheap.
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = Math.ceil((window.innerWidth * dpr) / 4)
    const h = Math.ceil((window.innerHeight * dpr) / 4)
    this.maskTarget = new RenderTarget(w, h, { samples: 1 })
    this.maskTarget.texture.format = RGBAFormat
  }

  _growMaskPool(n) {
    while (this.maskMeshes.length < n) {
      const m = new Mesh(this.maskGeo, this.maskMat)
      m.rotation.x = -Math.PI / 2 // lie flat on the XZ ground plane
      m.visible = false
      this.maskScene.add(m)
      this.maskMeshes.push(m)
    }
  }

  /**
   * Position the coverage discs for this frame.
   * @param {Array<{x:number,z:number,r:number}>} circles - world centres + radii
   */
  setTurretCircles(circles) {
    if (circles.length > this.maskMeshes.length) this._growMaskPool(circles.length)
    for (let i = 0; i < this.maskMeshes.length; i++) {
      const m = this.maskMeshes[i]
      if (i < circles.length) {
        const c = circles[i]
        m.position.set(c.x, 0, c.z)
        m.scale.set(c.r, c.r, 1) // CircleGeometry lives in local XY -> scale x,y
        m.visible = true
      } else {
        m.visible = false
      }
    }
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

    // Turret coverage glow: sample the union-of-circles mask (rendered to its
    // own RT in render()), blur it, and take (hard - blurred). That isolates a
    // gradient just INSIDE the union's outer edge, peaking at the edge and
    // fading inward. Added additively as a soft light-blue tint.
    const maskTex = texture(this.maskTarget.texture)
    const hardMask = maskTex.r // ~1 inside the union, 0 outside
    const softMask = gaussianBlur(maskTex, this.coverageBlur, 6).r
    // pow > 1 makes the gradient drop to zero faster, hugging the edge.
    const innerEdge = clamp(hardMask.sub(softMask), 0, 1).pow(2.0)
    const glowAlpha = clamp(
      innerEdge.mul(this.coverageStrength), 0, this.coverageOpacity
    ).mul(this.coverageEnabled)
    const withCoverage = withVignette.add(this.coverageColor.mul(glowAlpha))

    // Fade to black pass (final effect in chain)
    const fadeColor = vec3(0, 0, 0)
    const finalOutput = mix(fadeColor, withCoverage, this.fadeOpacity)

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

  /** Resize the coverage mask target with the window. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = Math.ceil((window.innerWidth * dpr) / 4)
    const h = Math.ceil((window.innerHeight * dpr) / 4)
    this.maskTarget.setSize(w, h)
  }

  render() {
    const { renderer } = this
    // Manual pass: render the turret discs into the low-res mask target, then
    // run the main pipeline (which samples that mask for the coverage glow).
    const savedRT = renderer.getRenderTarget()
    const savedClear = renderer.getClearColor(new Color())
    const savedAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget(this.maskTarget)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    renderer.render(this.maskScene, this.camera)

    renderer.setRenderTarget(savedRT)
    renderer.setClearColor(savedClear, savedAlpha)

    this.postProcessing.render()
  }
}
