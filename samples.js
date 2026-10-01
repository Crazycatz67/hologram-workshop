// The sample objects (stock models, not scans) offered next to the chair: in the gesture demo's
// carousel (models.js spreads SAMPLES in after the chair entries) and in the Platform's library
// (platform/main.js seeds sampleSeeds() next to the chair sample). One list, so the two pages
// can never disagree on a path or a credit.
//
// Contract:
//   SAMPLES: [{ id, title, path, credit, licence, parts }]
//     id      stable key: models.js uses it as the model id (per-model localStorage), the
//             Platform as the seed key (project id `sample-<id>`). Never rename one.
//     path    site-root-relative GLB in assets/samples/ (Y up, metres, floor at y = 0,
//             one named mesh per part; see assets/samples/SOURCES.md and build_samples.py)
//     credit  the in-app attribution line. CC BY models MUST show it wherever they are shown.
//     licence 'CC BY 4.0' | 'CC0 1.0'
//     parts   named meshes in the file (1 = no explode/part select beyond stretch mode)
//   sampleSeeds(base = '../') -> args for store.seedSample(), one per sample:
//     { key, title, versions: [{ label: 'Original', type: 'original', sources: [{ url, name }],
//       provenance: { note } }] }   base = path from the calling page to the site root.
//   Seeding is idempotent (fixed ids), so adding a sample later just adds a card; removing one
//   here leaves already-seeded copies in visitors' libraries (hide them there instead).

const ABO = 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0';

export const SAMPLES = [
  { id: 'tool-chest', title: 'Tool chest', path: 'assets/samples/tool-chest.glb', parts: 7, licence: 'CC0 1.0',
    credit: 'Metal Tool Chest by John Hutcheson & Yann Kervran, Poly Haven (CC0)' },
  { id: 'cabinet', title: 'Cabinet', path: 'assets/samples/cabinet.glb', parts: 5, licence: 'CC0 1.0',
    credit: 'Painted Wooden Cabinet by Kirill Sannikov, Poly Haven (CC0)' },
  { id: 'desk-lamp', title: 'Desk lamp', path: 'assets/samples/desk-lamp.glb', parts: 10, licence: 'CC0 1.0',
    credit: 'Desk Lamp Arm 01 by Kuutti Siitonen & Yann Kervran, Poly Haven (CC0)' },
  { id: 'sofa', title: 'Sofa', path: 'assets/samples/sofa.glb', parts: 9, licence: 'CC0 1.0',
    credit: 'Sofa 01 by Kirill Sannikov, Poly Haven (CC0)' },
  { id: 'barrel-chair', title: 'Barrel chair', path: 'assets/samples/barrel-chair.glb', parts: 6, licence: 'CC BY 4.0',
    credit: `Barrel chair from ${ABO}` },
  { id: 'bar-stool', title: 'Bar stool', path: 'assets/samples/bar-stool.glb', parts: 10, licence: 'CC BY 4.0',
    credit: `Bar stool from ${ABO}` },
  { id: 'pedestal-table', title: 'Pedestal table', path: 'assets/samples/pedestal-table.glb', parts: 13, licence: 'CC BY 4.0',
    credit: `Pedestal table from ${ABO}` },
  { id: 'lantern', title: 'Lantern', path: 'assets/samples/lantern.glb', parts: 2, licence: 'CC0 1.0',
    credit: 'Lantern 01 by Rajil Jose Macatangay, Poly Haven (CC0)' },
  { id: 'vase', title: 'Vase', path: 'assets/samples/vase.glb', parts: 1, licence: 'CC0 1.0',
    credit: 'Ceramic Vase 01 by James Ray Cock, Poly Haven (CC0)' },
  { id: 'teapot', title: 'Teapot', path: 'assets/samples/teapot.glb', parts: 1, licence: 'CC BY 4.0',
    credit: 'Threshold Porcelain Teapot, Google Scanned Objects (Google LLC), CC BY 4.0' }
];

export function sampleSeeds(base = '../') {
  return SAMPLES.map((s) => ({
    key: s.id,
    title: s.title,
    versions: [{
      label: 'Original', type: 'original',
      // A URL, like the chair sample: the bytes stay on the site, never copied into storage.
      sources: [{ url: base + s.path, name: s.path.split('/').pop() }],
      // The credit rides in the provenance note so it travels with the version (and exports).
      provenance: { note: `Stock model, not a scan. ${s.credit}`, credit: s.credit, licence: s.licence }
    }]
  }));
}
