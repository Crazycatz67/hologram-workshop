# assets/games: sources and licences for the playground games

| Game | Asset | Source | Licence |
| --- | --- | --- | --- |
| Block tower (`demos/tower/`) | blocks, floor, guide line | procedural three.js boxes (no files) | project's own |
| Marble maze (`demos/maze/`) | board, walls, holes, marble, goal ring | procedural three.js geometry; levels are 9-line strings in `demos/maze/demo.js` | project's own |
| both | physics | cannon-es 0.20.0, vendored at `demos/lib/cannon-es.js` (see `demos/lib/README.md`) | MIT, `demos/lib/cannon-es.LICENSE` |

Kenney Marble Kit (CC0) was considered and not used: it is marble-RUN track pieces (ramps,
funnels, bends), not flat maze tiles, so it doesn't fit a tilting maze board. No third-party
model or texture files are in this folder yet; add a row here before adding one.
