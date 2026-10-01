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

const { MeshStandardMaterial } = await import('three');

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
    materialFor, plainFor, prepare, update, settings, parents, inferredParents,
    setShowInferred, get showInferred() { return showInferred; },
    set(k, v) { settings[k] = v; applySettings(); }
  };
}
