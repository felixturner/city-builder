# TODO

- pull in good stuff from city-builder-plan1. back tracking, build all, soft cells?, plan1 doc
- add water shader like azuki village (only show noise on water color on map?) expensive? use other channel like emission for water shader area?
- add better skybox - styormy skies
- add rain / snow (like bad north / nuclear throne)
- improve color maps textures for 2 levels. keep rivers/roads the same color on both
- add wind trails like zelda
- coast ripples shader like diney map


- Add new TILES to help WFC: 
  - River dead-end, 
  - 4x road slope dead-ends (low/high). 
  - river slopes? 
  - coast slopes. 
  - branching bridges?.
- use bigger world noise fields for water, mountains + forests, cities?
- Consider manual compositing passes instead of MRT (fixes transparency, enables half-res AO for perf)
- Consider preventing road slopes up/down from meeting
- Edge biasing for coast/ocean - Pre-seed boundary cells with water before solving, or use position-based weights to boost ocean/coast near edges and grass near center
- Check cliff render heights - Why are there no outcrops with 1 high neighbor? GRASS_CLIFF_C (1 highEdge) should create single-tile plateaus but they're rare/not appearing as expected
- remove baked shadoews from blender file?
- Post - add subtle tilt shift, bleach,grain, LUT
- add extra tile with just 1 small bit of hill to fill jagged gaps in cliffs?(like coast)
- paint big noise color fileds over grasss for more variation
- find/make simpler house models
- add boats + carts?
- add birds + clouds?
- Update to latest threejs
- add rocks to hide dropped tiles?
- commision kaykit to add some tiles or hire 3d modeler - send him live link
  - add bushes like bad north


- rename hexgrid to grid? hexmap -> map?
- create new repo called hex-map-threejs, inside other folder for working trees
- push to git push live demo

- fix tree rotation with wind sway (currently rotation disabled — positionNode runs pre-batch so displacement gets rotated per-instance. need to counter-rotate using batch color channel or similar)
- fix HDR rotation (scene.backgroundRotation doesn't work through PostProcessing pass() node, scene.environmentRotation is WebGL-only. Custom envNode via material.envNode changes colors because it bypasses EnvironmentNode's radiance/irradiance pipeline. Possible fixes: override setupEnvironment to inject rotation into createRadianceContext/createIrradianceContext getUV, or update to newer three.js that may support environmentRotation in WebGPU)
- seperate mat for decs to allow more tree color control?
- fix build order UI to dissallow surrounding a tile (harder for WFC)
- add a little minifig meeple have his hex outline lit up. control him to walk around.
- day/night (cross fade skybox)
- add animated fires
- smoke from chimneys as meshes or puffs that fade
- add sound effects birds wind sounds
- fix lillies can get cropped by coast
- fix windmill fan drop
