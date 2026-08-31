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
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { FX_GLOW_LAYER } from './fx.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'

// Objects on this camera layer (laser beams, projectiles) skip the main scene
// pass entirely and are drawn as a plain overlay after AO/effects, so they don't
// receive ambient occlusion.
export const FX_NO_AO_LAYER = 1

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera

    this.postProcessing = new PostProcessing(renderer)

    // Effect toggle uniforms
    this.aoEnabled = uniform(1)
    this.vignetteEnabled = uniform(1)
    this.bloomEnabled = uniform(1)

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
    this.maskGeo = new CircleGeometry(1, 48) // unit disc, scaled per source
    const chan = (hex) => new MeshBasicNodeMaterial({
      color: hex, depthTest: false, depthWrite: false,
    })
    this.maskMat = chan(0xffffff) // turret coverage mask
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

    // Full-res target for the no-AO overlay layer (beams/projectiles). Rendered
    // each frame in render(), then composited over the AO'd image in the pipeline.
    const fw = window.innerWidth * dpr, fh = window.innerHeight * dpr
    this.overlayTarget = new RenderTarget(fw, fh, { samples: 1 })
    this.overlayTarget.texture.format = RGBAFormat

    // Half-res target holding ONLY the glow-layer objects. Half res because its
    // whole purpose is to be blurred into a halo - the mip chain throws that
    // detail away regardless, so rendering it sharp would be wasted work.
    //
    // TWO attachments, not one. Every FX material carries an mrtNode declaring
    // {output, normal} (see fx.js), and a material's MRT struct has to match the
    // attachments it is rendering into. Against a single-attachment target the
    // struct came out with zero members, which is invalid WGSL - and one invalid
    // pipeline invalidates the whole command buffer, so the entire pass, crates
    // included, silently rendered nothing. The second attachment is written and
    // never read; it exists to make the layouts agree.
    this.glowTarget = new RenderTarget(Math.ceil(fw / 2), Math.ceil(fh / 2), { samples: 1, count: 2 })
    for (const t of this.glowTarget.textures) t.format = RGBAFormat
    // These NAMES are load-bearing, not documentation. MRTNode.setup() resolves
    // each of a material's outputs to an attachment by matching texture.name
    // (see getTextureIndex), and an unnamed attachment matches nothing - so
    // every output was dropped and the struct was emitted with zero members,
    // which WGSL rejects. PassNode names its own targets exactly this way.
    this.glowTarget.textures[0].name = 'output'
    this.glowTarget.textures[1].name = 'normal'
  }

  /**
   * Depth-only stand-in used to prime the glow target's depth buffer.
   *
   * colorWrite off, so it lays depth and contributes no colour. It still needs a
   * valid MRT struct - the shader is compiled either way - hence the mrtNode.
   */
  _glowDepthMaterial() {
    if (!this._glowDepthMat) {
      const m = new MeshBasicNodeMaterial({ colorWrite: false })
      m.mrtNode = mrt({ output: output, normal: vec3(0, 1, 0) })
      this._glowDepthMat = m
    }
    return this._glowDepthMat
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

    // Scene pass with MRT for normal output. No-AO objects (beams/projectiles)
    // live on FX_NO_AO_LAYER, which the camera's default layer-0 mask skips; they
    // are drawn as an overlay in render() instead.
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

    // No-AO overlay (beams/projectiles): rendered to overlayTarget in render(),
    // composited over the AO'd image (premultiplied-alpha over).
    const overlayTex = texture(this.overlayTarget.texture)
    const withOverlay = withAO.mul(float(1).sub(overlayTex.a)).add(overlayTex.rgb)

    // Bloom, fed ONLY the glow layer (see fx.js). Thresholding the whole scene
    // meant anything bright glowed whether or not it was meant to; this way a
    // thing glows because it was put on the layer, and material brightness has
    // nothing to do with it. Hence threshold 0 - the layer IS the selection.
    const glowTex = texture(this.glowTarget.textures[0]) // [1] is the unused normal attachment
    this.bloomPass = bloom(glowTex, 1.1, 0.7, 0)
    const withBloom = withOverlay.add(this.bloomPass.rgb.mul(this.bloomEnabled))

    // Vignette: darken edges toward black
    const vignetteFactor = float(1).sub(
      clamp(viewportUV.sub(0.5).length().mul(1.4), 0.0, 1.0).pow(1.5)
    )
    const vignetteMultiplier = mix(float(1), vignetteFactor, this.vignetteEnabled)
    const withVignette = mix(vec3(0, 0, 0), withBloom, vignetteMultiplier)

    // Turret coverage glow: sample the union-of-circles mask (rendered to its
    // own RT in render()), blur it, and take (hard - blurred). That isolates a
    // gradient just INSIDE the union's outer edge, peaking at the edge and
    // fading inward. Added additively as a soft light-blue tint.
    const maskTex = texture(this.maskTarget.texture)
    // Blur the union-of-discs mask; the edge gradient becomes the glow.
    const blurred = gaussianBlur(maskTex, this.coverageBlur, 6)
    // pow > 1 makes the gradient drop to zero faster, hugging the edge.
    const edgeGlow = (hard, soft) => clamp(
      clamp(hard.sub(soft), 0, 1).pow(2.0).mul(this.coverageStrength),
      0, this.coverageOpacity
    ).mul(this.coverageEnabled)
    const withCoverage = withVignette.add(this.coverageColor.mul(edgeGlow(maskTex.r, blurred.r)))

    // Fade to black pass (final effect in chain)
    const fadeColor = vec3(0, 0, 0)
    const finalOutput = mix(fadeColor, withCoverage, this.fadeOpacity)

    // Debug views
    const depthViz = vec3(scenePassDepth)
    const normalViz = scenePassNormal.mul(0.5).add(0.5)
    const aoViz = vec3(blurredAO)
    // 5 = what the glow pass actually captured, 6 = what bloom makes of it.
    // Between them these say whether a missing glow is the LAYER (nothing in 5)
    // or the composite (something in 5, nothing in 6).
    const glowViz = glowTex.rgb
    const bloomViz = this.bloomPass.rgb

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
          select(
            this.debugView.lessThan(3.5),
            normalViz,
            select(
              this.debugView.lessThan(4.5),
              aoViz,
              select(this.debugView.lessThan(5.5), glowViz, bloomViz)
            )
          )
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
    this.overlayTarget.setSize(window.innerWidth * dpr, window.innerHeight * dpr)
    this.glowTarget.setSize(
      Math.ceil((window.innerWidth * dpr) / 2),
      Math.ceil((window.innerHeight * dpr) / 2)
    )
  }

  render() {
    const { renderer, scene, camera } = this
    const savedRT = renderer.getRenderTarget()
    const savedClear = renderer.getClearColor(new Color())
    const savedAlpha = renderer.getClearAlpha()

    // Manual pass: render the turret discs into the low-res mask target.
    renderer.setRenderTarget(this.maskTarget)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    renderer.render(this.maskScene, this.camera)

    // No-AO overlay pass: render only the FX_NO_AO_LAYER objects (beams,
    // projectiles) to overlayTarget over a transparent clear.
    const savedBg = scene.background
    const savedMask = camera.layers.mask
    scene.background = null
    camera.layers.set(FX_NO_AO_LAYER)
    renderer.setRenderTarget(this.overlayTarget)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, camera)
    // Glow pass, in two steps.
    //
    // The target has its own depth buffer, and an empty one means nothing can
    // occlude the glow - trails and the king's beam shine straight through the
    // city. So first PRIME that depth with the solid geometry, then draw the
    // glow objects against it with the depth test doing the masking for us.
    //
    // The scene pass's depth would be the obvious thing to borrow, but it is
    // written later in this same frame (inside postProcessing.render below), so
    // it would always be one frame stale and would crawl at silhouette edges
    // whenever the camera moved.
    //
    // Occluders are the opaque, non-glowing meshes. Glow objects are held out so
    // they cannot occlude each other - overlapping trail segments would
    // otherwise cut into one another, which is the very thing their
    // depthWrite:false avoids in the main pass. Transparent meshes are held out
    // for the same reason: a sheet of additive floor is not something you want
    // hiding the trail lying on top of it.
    const hidden = []
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      const m = o.material
      const isTransparent = Array.isArray(m) ? m.some(x => x && x.transparent) : m && m.transparent
      if (o.layers.isEnabled(FX_GLOW_LAYER) || isTransparent) {
        o.visible = false
        hidden.push(o)
      }
    })

    renderer.setRenderTarget(this.glowTarget)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    camera.layers.mask = savedMask // occluders live on the ordinary layer
    scene.overrideMaterial = this._glowDepthMaterial()
    renderer.render(scene, camera)
    scene.overrideMaterial = null

    for (const o of hidden) o.visible = true

    // Now the glow objects themselves, keeping the depth we just laid down.
    const savedAutoClear = renderer.autoClear
    renderer.autoClear = false
    camera.layers.set(FX_GLOW_LAYER)
    renderer.render(scene, camera)
    renderer.autoClear = savedAutoClear

    camera.layers.mask = savedMask
    scene.background = savedBg

    renderer.setRenderTarget(savedRT)
    renderer.setClearColor(savedClear, savedAlpha)

    // Main pipeline (camera is back on layer 0, so it skips the overlay layer;
    // the pipeline samples overlayTarget for the composite).
    this.postProcessing.render()
  }
}
