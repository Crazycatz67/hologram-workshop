// The platform's hologram look: photosafe by default, with the scan's real detail blendable
// back in. Owns every hologram material on the page so there is one place to get it right.
//
//   Realism   0 = pure hologram, 1 = the object's real colours (scan texture, photo colours,
//             or a neutral clay shade for geometry-only scans), always with a faint rim.
//             For the moments the hologram look strips out detail you actually want --
//             judging a texture, a shade, a material.
//   Motion    how much the hologram animates (scanline drift, breathing). 0 = still.
//             Starts at 0 when the OS asks for reduced motion.
//   Breathing an optional slow (0.3 Hz), shallow glow pulse. Off in the Calm preset.
//
//   Inferred  surfaces Track B filled in (mesh.userData.inferred, see upload.js) get their own
//             variant of every material below: the same hologram, ghosted (dimmer, partly
//             desaturated) with a static diagonal hatch, so filled-in geometry is always
//             visibly marked. setShowInferred(false) hides them ("As scanned") in both
//             render passes; it is a view setting, not saved.
//
// Safety is not a setting: every configuration here stays under the WCAG flash limit
// (safety-test.html), single-layer rendering stops additive bloom, and rough scans get
// smoothed shading automatically (hologramLook.js). Settings persist per browser.

const V = new URL(import.meta.url).search;
const { default: HolographicMaterial } = await import('../HolographicMaterial.js' + V);
const { prepareHologram, enableSingleLayer } = await import('../hologramLook.js' + V);

const { MeshStandardMaterial, ShaderMaterial, MeshBasicMaterial, Color, Vector2, DoubleSide } = await import('three');

const STORE_KEY = 'hologram-platform-look';

// The inferred look. Pixel-space hatch with a 12 px period (well above the 4 px aliasing
// floor HolographicMaterial uses for scanlines) and NO time term: it never animates, so it
// adds nothing a flash counter can see. Low contrast on purpose -- striped patterns are a
// photosensitivity trigger in their own right when they are high-contrast (ITU-R BT.1702),
// so the bars differ by ~20% of an already-dimmed surface. p5-test.html measures both.
export const INFERRED_DIM = 0.5;       // x scanned brightness
export const INFERRED_HATCH = 0.4;     // depth of the hatch modulation (0 = none)
export const INFERRED_HATCH_PX = 12.0;
const HATCH_GLSL = `
  {
    // P5: inferred (filled-in) surface -- ghosted + static hatch. See platform/look.js.
    float hatch = smoothstep(0.2, 0.8, 0.5 + 0.5 * sin((gl_FragCoord.x + gl_FragCoord.y) * 6.2831853 / ${INFERRED_HATCH_PX.toFixed(1)}));
    vec3 ghost = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.3333))), 0.35);
    gl_FragColor.rgb = ghost * ${INFERRED_DIM.toFixed(3)} * (${(1 - INFERRED_HATCH).toFixed(3)} + ${INFERRED_HATCH.toFixed(3)} * hatch);
  }`;

// Appends the hatch to the end of a HolographicMaterial's main() (after gl_FragColor is set).
function markInferred(m) {
  const src = m.fragmentShader;
  const end = src.lastIndexOf('}');
  if (end < 0) throw new Error('look.js: unexpected hologram fragment shader');
  m.fragmentShader = src.slice(0, end) + HATCH_GLSL + '\n' + src.slice(end);
  m.userData.inferred = true;
  return m;
}
const BASE = {
  hologramColor: '#4fd1ff', hologramBrightness: 1.25, fresnelAmount: 0.45, fresnelOpacity: 1.0,
  scanlineSize: 40.0, signalSpeed: 0.6, hologramOpacity: 1.0, blinkFresnelOnly: true
};

// ---- Polygon lens (polygon.js) -----------------------------------------------------------
// The scan's real triangles, drawn as a barycentric wireframe only inside a circle under the
// mouse. Photosafety (BUGS #14) shapes every choice here:
//   * normal blending at low opacity, never additive: lines can't stack into a bright blob;
//   * no time term at all: the wire only changes when the mouse or camera moves;
//   * DENSITY FADE: a triangle smaller than ~LENS_FADE_FROM_PX on screen fades its lines out
//     (gone by LENS_FADE_TO_PX), so a dense patch reads as a soft tint, not a shimmering
//     moire of 1-px lines (dense high-contrast line patterns are a trigger, ITU-R BT.1702);
//   * the circle's edge is a soft falloff, so faces entering the lens fade in, not pop;
//   * inferred faces are dimmer AND dashed (dashes anchored to the edge, so they don't crawl).
// Per-vertex attributes: bary (vec3, one corner each), inferred (0/1).
export const LENS_OPACITY = 0.55;
export const LENS_INFERRED_DIM = 0.6;
export const LENS_FADE_FROM_PX = 12;   // triangle size (px across) where lines start to fade
export const LENS_FADE_TO_PX = 4;      // ...and are gone
// The FULL wire (polygon mode on, BUGS #46): the whole model as triangles, calmer than the lens.
// polygon.js picks a simplification level whose triangles are ~WIRE_EDGE_PX across on screen,
// so it reads as a mesh at any zoom; the same density fade still covers what's left too small.
export const WIRE_OPACITY = 0.38;
// While polygon mode is on the hologram skin eases down to this (x its normal opacity), so the
// wire is the obvious thing on screen. A dimming, eased over ~0.4 s: never a flash.
export const SKIN_FAINT = 0.3;
// full = false: the lens (lines only inside the circle under the mouse);
// full = true:  the whole-model wire (no circle, WIRE_OPACITY).
export function createLensMaterial({ full = false } = {}) {
  return new ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: DoubleSide,
    // Pull the wire a hair toward the camera so it wins the depth test against its own surface.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    uniforms: {
      uCentre: { value: new Vector2() }, uRadius: { value: 80 }, uFade: { value: 0 },
      uUseLens: { value: full ? 0 : 1 }, uOpacity: { value: full ? WIRE_OPACITY : LENS_OPACITY },
      uColor: { value: new Color('#c8f6ff') }, uInfColor: { value: new Color('#9ec3d0') }
    },
    vertexShader: `
      attribute vec3 bary; attribute float inferred;
      varying vec3 vBary; varying float vInf;
      void main() { vBary = bary; vInf = inferred; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec2 uCentre; uniform float uRadius; uniform float uFade; uniform float uUseLens; uniform float uOpacity;
      uniform vec3 uColor; uniform vec3 uInfColor;
      varying vec3 vBary; varying float vInf;
      void main() {
        vec3 w = fwidth(vBary);
        vec3 a = smoothstep(vec3(0.0), w * 1.25, vBary);
        float line = 1.0 - min(min(a.x, a.y), a.z);
        // fwidth(bary) ~ 1 / (triangle size in px): small on screen -> fade the lines out.
        float density = smoothstep(${(1 / LENS_FADE_TO_PX).toFixed(4)}, ${(1 / LENS_FADE_FROM_PX).toFixed(4)}, max(w.x, max(w.y, w.z)));
        float lens = mix(1.0, 1.0 - smoothstep(0.7 * uRadius, uRadius, distance(gl_FragCoord.xy, uCentre)), uUseLens);
        float alpha = line * density * lens * uFade * uOpacity;
        vec3 col = uColor;
        if (vInf > 0.5) {
          // Dashed: position along the nearest edge, 3 dashes per edge.
          float t = vBary.x < vBary.y ? (vBary.x < vBary.z ? vBary.y : vBary.x) : (vBary.y < vBary.z ? vBary.z : vBary.x);
          alpha *= ${LENS_INFERRED_DIM.toFixed(3)} * step(0.5, fract(t * 3.0));
          col = uInfColor;
        }
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col, alpha);
      }`
  });
}
// Depth for the full wire: the wire is a simplified copy, not the surface the hologram drew, so
// it gets its own depth (polygon.js clears depth just before this draws, then the wire tests
// against it): hidden lines stay hidden at every LOD level and nothing z-fights.
export function createWireDepthMaterial() {
  return new MeshBasicMaterial({ colorWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}
// The selected patch: a flat, static amber tint (the object-mode selection colour), low enough
// that the hologram still shows through.
export const PATCH_OPACITY = 0.28;
export function createPatchMaterial() {
  return new MeshBasicMaterial({
    color: 0xffb040, transparent: true, opacity: PATCH_OPACITY, depthWrite: false, side: DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
  });
}

function loadSettings() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const defaults = { realism: 0, motion: reduce ? 0 : 0.6, breathing: !reduce };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { return defaults; }
}

export function createLook({ scene, mount }) {
  const parents = {
    base: new HolographicMaterial(BASE),
    hover: new HolographicMaterial({ ...BASE, hologramColor: '#d6fbff', hologramBrightness: 1.6, fresnelAmount: 0.6 }),
    selected: new HolographicMaterial({ ...BASE, hologramColor: '#ffb040', hologramBrightness: 1.6, fresnelAmount: 0.6 }),
  };
  // Inferred parents share every uniform with the scanned ones (variant()), so Realism,
  // Motion and the per-frame clock drive both; only the shader's last step differs.
  const inferredParents = Object.fromEntries(Object.entries(parents).map(([k, p]) => [k, markInferred(p.variant())]));
  enableSingleLayer(scene, [...Object.values(parents), ...Object.values(inferredParents)]);
  const variants = new WeakMap();   // mesh -> { base, hover, selected }

  // Plain-mode stand-in for inferred surfaces (Plain mode must still mark them): the plain
  // clay colour, see-through, with the same static hatch.
  const plainInferred = new MeshStandardMaterial({ color: 0x8fd3ff, roughness: 0.6, transparent: true, opacity: 0.45, depthWrite: false });
  plainInferred.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>' + HATCH_GLSL);
  };
  plainInferred.customProgramCacheKey = () => 'platform-inferred-plain';
  plainInferred.userData.inferred = true;

  // Every inferred material, for the As scanned / Completed switch. material.visible = false
  // drops the mesh from BOTH passes (three skips it when building the render list), so a
  // hidden inferred surface can't leave a depth hole in the single-layer pre-pass either.
  const inferredMats = new Set([...Object.values(inferredParents), plainInferred]);
  let showInferred = true;
  const track = (m) => { m.visible = showInferred; inferredMats.add(m); return m; };

  const settings = loadSettings();
  function applySettings() {
    for (const m of Object.values(parents)) {
      m.uniforms.realism.value = settings.realism;
      m.uniforms.blinkAmount.value = settings.breathing ? 0.08 : 0;
      m.motion = settings.motion;
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  }

  // A mesh with its own colour source (texture map or vertex colours, from the loaded
  // material kept on userData.original) gets variants that share every look uniform with
  // the parents; anything else just uses the parents.
  function materialFor(mesh, kind = 'base') {
    const inferred = !!mesh?.userData?.inferred;
    const o = mesh?.userData?.original;
    const map = o?.map ?? null;
    const vertexColors = !!(o?.vertexColors && mesh.geometry.attributes.color);
    if (!map && !vertexColors) return (inferred ? inferredParents : parents)[kind];
    let v = variants.get(mesh);
    if (!v) {
      v = Object.fromEntries(Object.entries(parents).map(([k, p]) => {
        const m = p.variant({ map, vertexColors });
        return [k, inferred ? track(markInferred(m)) : m];
      }));
      variants.set(mesh, v);
    }
    return v[kind];
  }

  // Plain mode: null means "use your own plain material"; inferred meshes get the hatched one.
  function plainFor(mesh) { return mesh?.userData?.inferred ? plainInferred : null; }

  function setShowInferred(v) {
    showInferred = !!v;
    for (const m of inferredMats) m.visible = showInferred;
  }

  // Once per loaded model: smooth the shading on rough scans (no vertex moves).
  function prepare(root) { prepareHologram(root); }

  function update() { for (const m of Object.values(parents)) m.update(); }

  // Polygon mode's faint skin: k = 1 normal .. SKIN_FAINT. hologramOpacity is shared by reference
  // with every variant and inferred parent, so this reaches every hologram mesh. (Realism > 0
  // blends opacity toward 1, so the skin fades less there; Plain mode is opaque and unaffected.)
  function setSkin(k) { for (const m of Object.values(parents)) m.uniforms.hologramOpacity.value = BASE.hologramOpacity * k; }

  // Controls
  if (mount) {
    mount.innerHTML = `
      <div class="look-row"><label for="look-realism">Realism</label>
        <input id="look-realism" type="range" min="0" max="1" step="0.05"><span id="look-realism-v"></span></div>
      <div class="look-row"><label for="look-motion">Motion</label>
        <input id="look-motion" type="range" min="0" max="1" step="0.05"><span id="look-motion-v"></span></div>
      <div class="look-row"><label><input id="look-breathing" type="checkbox"> Gentle glow pulse</label>
        <button id="look-calm" type="button" title="Still, no pulse">Calm</button></div>`;
    const $ = (id) => mount.querySelector('#' + id);
    const sync = () => {
      $('look-realism').value = settings.realism;
      $('look-realism-v').textContent = `${Math.round(settings.realism * 100)}%`;
      $('look-motion').value = settings.motion;
      $('look-motion-v').textContent = settings.motion === 0 ? 'still' : `${Math.round(settings.motion * 100)}%`;
      $('look-breathing').checked = settings.breathing;
    };
    $('look-realism').addEventListener('input', (e) => { settings.realism = +e.target.value; applySettings(); sync(); });
    $('look-motion').addEventListener('input', (e) => { settings.motion = +e.target.value; applySettings(); sync(); });
    $('look-breathing').addEventListener('change', (e) => { settings.breathing = e.target.checked; applySettings(); sync(); });
    $('look-calm').addEventListener('click', () => { settings.motion = 0; settings.breathing = false; applySettings(); sync(); });
    sync();
  }
  applySettings();

  return {
    materialFor, plainFor, prepare, update, settings, parents, inferredParents, setSkin,
    setShowInferred, get showInferred() { return showInferred; },
    set(k, v) { settings[k] = v; applySettings(); }
  };
}
