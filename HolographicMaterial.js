/**
 * Holographic material by Anderson Mancini - Dec 2023.
 *
 * Vendored verbatim from github.com/ektogamat/threejs-vanilla-holographic-material
 * (src/HolographicMaterialVanilla.js, MIT license) rather than imported as a package —
 * it isn't published to npm, and the repo itself is a private Vite demo whose only
 * reusable part is this one file. Call `.update()` once per frame to advance the
 * animated time uniform; nothing else here needs a build step.
 *
 * PHOTOSAFETY REWRITE (2026-09-29) -- deliberate deviations from the vendored shader,
 * measured with safety-test.html (WCAG 2.3.1: at most 3 flashes in any 1 s):
 *   - The "blink" was fract(cos(t) * 43758.5) -- a random hash whose input moves far enough
 *     every frame to return a NEW random value every frame. With the v1 settings the rim
 *     jumped between 0% and 100% brightness ~60 times a second: 27 flashes/s measured.
 *     Replaced by a slow sine "breathing" (0.3 Hz) whose depth is capped at 15%.
 *   - Scanlines were computed in screen UV at 60 x scanlineSize cycles per screen -- 2400
 *     at v1's scanlineSize 40, far finer than a pixel, i.e. aliasing noise that re-rolls
 *     as anything moves (shimmer). They are now drawn in PIXEL space with a period that
 *     can't go below 4 px, plus a soft, slow sweep band instead of a hard-edged gate.
 *   - The whole-object pulse swung brightness 25% -> 100%; now a gentle +-10%.
 *   - All animation runs on an internal clock scaled by `motion` (0 = still), which
 *     defaults to 0 when the OS asks for reduced motion.
 *   - Brightness changes (v1 brightens on every gesture) ease over ~0.3 s via
 *     setBrightness() instead of jumping.
 *   - `realism` blends the object's real colour (texture map or vertex colours) back in,
 *     so scan and photo detail isn't lost when you want it.
 * The additive "bloom" stacking and rough-scan sparkle are geometry-side problems and are
 * fixed in hologramLook.js (single-layer depth pre-pass, shading-normal smoothing).
 */
import { ShaderMaterial, Clock, Uniform, Color, NormalBlending, AdditiveBlending, FrontSide, BackSide, DoubleSide } from 'three';

class HolographicMaterial extends ShaderMaterial {

  static BRIGHTNESS_EASE_SECONDS = 0.3;

  /**
   * Create a HolographicMaterial.
   *
   * @param {Object} parameters - The parameters to configure the material.
   * @param {number} [parameters.time=0.0] - The time uniform representing animation time.
   * @param {number} [parameters.fresnelOpacity=1.0] - The opacity for the fresnel effect.
   * @param {number} [parameters.fresnelAmount=1.0] - The strength of the fresnel effect.
   * @param {number} [parameters.scanlineSize=15.0] - The size of the scanline effect.
   * @param {number} [parameters.hologramBrightness=1.0] - The brightness of the hologram.
   * @param {number} [parameters.signalSpeed=1.0] - The speed of the signal effect.
   * @param {Color} [parameters.hologramColor=new Color('#00d5ff')] - The color of the hologram.
   * @param {boolean} [parameters.enableBlinking=true] - Enable/disable blinking effect.
   * @param {boolean} [parameters.blinkFresnelOnly=false] - Enable blinking only on the fresnel effect.
   * @param {number} [parameters.hologramOpacity=1.0] - The opacity of the hologram.
   * @param {number} [parameters.blendMode=NormalBlending] - The blending mode. Use `THREE.NormalBlending` or `THREE.AdditiveBlending`.
   * @param {number} [parameters.side=FrontSide] - The rendering side. Use `THREE.FrontSide`, `THREE.BackSide`, or `THREE.DoubleSide`.
   * @param {Boolean} [parameters.depthTest=true] - Enable or disable depthTest.
   */

  constructor(parameters = {}) {
    super();

    this.vertexShader = /*GLSL */
    `
      #define STANDARD
      varying vec3 vViewPosition;
      #ifdef USE_TRANSMISSION
      varying vec3 vWorldPosition;
      #endif
    
      varying vec2 vUv;
      varying vec4 vPos;
      varying vec3 vNormalW;
      varying vec3 vPositionW;
      varying vec3 vColorH;

      #include <common>
      #include <uv_pars_vertex>
      #include <envmap_pars_vertex>
      #include <color_pars_vertex>
      #include <fog_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      #include <clipping_planes_pars_vertex>

      void main() {
        
        #include <uv_vertex>
        #include <color_vertex>
        #include <morphcolor_vertex>
      
        #if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
      
          #include <beginnormal_vertex>
          #include <morphnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <defaultnormal_vertex>
      
        #endif
      
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        #include <logdepthbuf_vertex>
        #include <clipping_planes_vertex>
      
        #include <worldpos_vertex>
        #include <envmap_vertex>
        #include <fog_vertex>

        vUv = uv;
        #ifdef USE_COLOR
          vColorH = color;
        #else
          vColorH = vec3(1.0);
        #endif
        // gl_Position comes from <project_vertex> above, exactly as three's own materials
        // compute it. The vendored shader overwrote it with (projection * modelView) * p --
        // same maths, different rounding -- which z-fought hologramLook's depth pre-pass
        // (measured: 17 flashes/s from that alone). vPos reuses it for the same reason.
        vPos = gl_Position;
        vPositionW = vec3( vec4( transformed, 1.0 ) * modelMatrix);
        vNormalW = normalize( vec3( vec4( normal, 0.0 ) * modelMatrix ) );


      }`

    this.fragmentShader = /*GLSL */
    ` 
      varying vec2 vUv;
      varying vec3 vPositionW;
      varying vec4 vPos;
      varying vec3 vNormalW;
      varying vec3 vColorH;
      
      uniform float time;              // animated time: already scaled by motion (see update)
      uniform float fresnelOpacity;
      uniform float scanlineSize;
      uniform float fresnelAmount;
      uniform float signalSpeed;
      uniform float hologramBrightness;
      uniform float hologramOpacity;
      uniform bool blinkFresnelOnly;
      uniform float blinkAmount;       // 0..0.15: depth of the slow breathing (was a strobe)
      uniform float scanlinePeriod;    // pixels per scanline, never below 4 (no aliasing)
      uniform vec3 hologramColor;
      uniform float realism;           // 0 = pure hologram, 1 = the object's real colours
      uniform bool useMap;
      uniform sampler2D baseMap;

      float random(in float a, in float b) { return fract((cos(dot(vec2(a,b) ,vec2(12.9898,78.233))) * 43758.5453)); }

      void main() {
        vec2 vCoords = vPos.xy / vPos.w * 0.5 + 0.5;

        // Body colour (unchanged from the vendored shader)
        float bodyAlpha = mix(hologramBrightness, vUv.y, 0.5);
        vec3 body = hologramColor * bodyAlpha;

        // Scanlines in pixel space: fine lines that can't alias, drifting slowly
        float period = max(scanlinePeriod, 4.0);
        float lines = 0.5 + 0.5 * sin(gl_FragCoord.y * 6.2831853 / period - time * signalSpeed * 3.0);
        // One soft, wide band sweeping down the screen (~20 s per pass at v1 speed)
        float sweepPos = fract(vCoords.y * 0.5 + time * signalSpeed * 0.08);
        float sweep = exp(-pow((sweepPos - 0.5) * 7.0, 2.0));
        float grain = random(vUv.x, vUv.y);
        float pulse = 0.9 + 0.1 * sin(time * signalSpeed);
        vec3 scan = hologramColor * (0.10 * lines + 0.12 * sweep) * (0.6 + 0.4 * grain);
        vec3 holoBody = (body + scan) * pulse;

        // Fresnel rim (unchanged formula)
        vec3 viewDirectionW = normalize(cameraPosition - vPositionW);
        vec3 N = normalize(vNormalW);
        float fresnelEffect = dot(viewDirectionW, N) * (1.6 - fresnelOpacity/2.);
        fresnelEffect = clamp(fresnelAmount - fresnelEffect, 0., fresnelOpacity);

        // Slow breathing instead of the per-frame random blink (0.3 Hz, depth capped)
        float breathe = 1.0 - clamp(blinkAmount, 0.0, 0.15) * (0.5 + 0.5 * sin(time * 1.885));

        vec3 holo = blinkFresnelOnly
          ? holoBody + fresnelEffect * breathe
          : holoBody * breathe + fresnelEffect;

        // Realism: the object's own colour, head-lit, with a faint hologram rim kept on
        vec3 base = vec3(0.8);
        if (useMap) base = texture2D(baseMap, vUv).rgb;
        base *= vColorH;
        float facing = abs(dot(viewDirectionW, N));
        vec3 real = pow(base * (0.35 + 0.65 * facing), vec3(1.0 / 2.2)) + hologramColor * fresnelEffect * 0.35;

        gl_FragColor = vec4(mix(holo, real, realism), mix(hologramOpacity, 1.0, realism));
      }`

      // Set default values or modify existing properties if needed
      this.uniforms = {
        /**
         * The time uniform representing animation time.
         * @type {Uniform<number>}
         * @default 0.0
         */
        time: new Uniform(0),
  
        /**
         * The opacity for the fresnel effect.
         * @type {Uniform<number>}
         * @default 1.0
         */
        fresnelOpacity: new Uniform(parameters.fresnelOpacity !== undefined ? parameters.fresnelOpacity : 1.0),
  
        /**
         * The strength of the fresnel effect.
         * @type {Uniform<number>}
         * @default 1.0
         */
        fresnelAmount: new Uniform(parameters.fresnelAmount !== undefined ? parameters.fresnelAmount : 0.45),
  
        /**
         * The size of the scanline effect.
         * @type {Uniform<number>}
         * @default 1.0
         */
        scanlineSize: new Uniform(parameters.scanlineSize !== undefined ? parameters.scanlineSize : 8.0),
  
        /**
         * The brightness of the hologram.
         * @type {Uniform<number>}
         * @default 1.0
         */
        hologramBrightness: new Uniform(parameters.hologramBrightness !== undefined ? parameters.hologramBrightness : 1.0),
  
        /**
         * The speed of the signal effect.
         * @type {Uniform<number>}
         * @default 1.0
         */
        signalSpeed: new Uniform(parameters.signalSpeed !== undefined ? parameters.signalSpeed : 1.0),
  
        /**
         * The color of the hologram.
         * @type {Uniform<Color>}
         * @default new Color(0xFFFFFF)
         */
        hologramColor: new Uniform(parameters.hologramColor !== undefined ? new Color(parameters.hologramColor) : new Color("#00d5ff")),
  
        /**
         * Enable/disable blinking effect.
         * @type {Uniform<boolean>}
         * @default true
         */
        enableBlinking: new Uniform(parameters.enableBlinking !== undefined ? parameters.enableBlinking : true),
  
        /**
         * Enable blinking only on the fresnel effect.
         * @type {Uniform<boolean>}
         * @default false
         */
        blinkFresnelOnly: new Uniform(parameters.blinkFresnelOnly !== undefined ? parameters.blinkFresnelOnly : true),
  
        /**
         * The opacity of the hologram.
         * @type {Uniform<number>}
         * @default 1.0
         */
        hologramOpacity: new Uniform(parameters.hologramOpacity !== undefined ? parameters.hologramOpacity : 1.0),

        // Photosafety rewrite -- see the header. enableBlinking stays for API compatibility
        // and now just chooses between a gentle breathing depth and none.
        blinkAmount: new Uniform(Math.min(0.15, parameters.blinkAmount !== undefined
          ? parameters.blinkAmount : (parameters.enableBlinking === false ? 0 : 0.08))),
        scanlinePeriod: new Uniform(parameters.scanlinePeriod !== undefined ? parameters.scanlinePeriod : 6.0),
        realism: new Uniform(parameters.realism !== undefined ? parameters.realism : 0.0),
        useMap: new Uniform(false),
        baseMap: new Uniform(null),
      };
  
      this.clock = new Clock()
      // 1 = normal, 0 = still. Defaults to still when the OS asks for reduced motion.
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.motion = parameters.motion !== undefined ? parameters.motion : (reduce ? 0 : 1);
      // Deviation from the vendored source (2026-09-05): the original called
      // this.setValues(parameters) here, passing through the whole parameters object.
      // Every genuine THREE.Material property it could set (depthTest, blending,
      // transparent, side) gets explicitly overwritten on the next four lines regardless,
      // so it does nothing except log a console warning for each hologram-specific key
      // (hologramColor, fresnelAmount, etc.) that isn't a real Material property. Confirmed
      // by testing that removing it changes no rendered output, only removes noise.
      this.depthTest = parameters.depthTest !== undefined ? parameters.depthTest : false;
      this.blending = parameters.blendMode !== undefined ? parameters.blendMode : AdditiveBlending;
      this.transparent = true;
      this.side = parameters.side !== undefined ? parameters.side : FrontSide;

  }

  /**
   * Advance the animation. Pass `nowSeconds` for deterministic rendering (safety-test.html);
   * otherwise the material's own clock is used. The shader's time is an internal clock
   * scaled by `motion`, so changing motion never makes the animation jump.
   */
  update(nowSeconds) {
    const now = nowSeconds ?? this.clock.getElapsedTime();
    const dt = Math.min(0.1, Math.max(0, now - (this._lastNow ?? now)));
    this._lastNow = now;
    this._animTime = (this._animTime ?? 0) + dt * this.motion;
    this.uniforms.time.value = this._animTime;

    const b = this.uniforms.hologramBrightness;
    if (this._brightnessTarget !== undefined && b.value !== this._brightnessTarget) {
      const k = 1 - Math.exp(-dt / HolographicMaterial.BRIGHTNESS_EASE_SECONDS);
      b.value += (this._brightnessTarget - b.value) * k;
      if (Math.abs(b.value - this._brightnessTarget) < 1e-3) b.value = this._brightnessTarget;
    }
  }

  /** Change brightness smoothly (a step change is a flash). `instant` for resets. */
  setBrightness(value, { instant = false } = {}) {
    this._brightnessTarget = value;
    if (instant) this.uniforms.hologramBrightness.value = value;
  }

  /**
   * A copy for one mesh that needs its own colour source (a scan texture or vertex
   * colours) while sharing every animated/look uniform with this material by reference --
   * so one update() call and one slider still drive every mesh.
   */
  variant({ map = null, vertexColors = false } = {}) {
    const m = new HolographicMaterial();
    m.uniforms = { ...this.uniforms, useMap: new Uniform(!!map), baseMap: new Uniform(map) };
    m.vertexColors = vertexColors;
    for (const k of ['depthTest', 'depthWrite', 'depthFunc', 'blending', 'transparent', 'side']) m[k] = this[k];
    m.update = () => {};          // the parent drives the shared uniforms
    m.setBrightness = (...a) => this.setBrightness(...a);
    return m;
  }

}

export default HolographicMaterial ;