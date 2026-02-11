# TODO

- Figure out how to get less wFC fails. bad seeds: 79319 (click 1,-1) , 351921 initial
- Add new TILES: River dead-end, road slope dead-ends (low/high). river slopes? coast slopes. branching bridges? to help WFC.

- fix coast can make weird strips
- use bigger world noise fields for water, mountains + forests, cities?
- add rocks + plants
- add stepped rocks by cliffs
- Consider manual compositing passes instead of MRT (fixes transparency, enables half-res AO for perf)
- Consider preventing road slopes from meeting (use 'road_slope' edge type instead of 'road')
- Edge biasing for coast/ocean - Pre-seed boundary cells with water before solving, or use position-based weights to boost ocean/coast near edges and grass near center
- Check cliff render heights - Why are there no outcrops with 1 high neighbor? GRASS_CLIFF_C (1 highEdge) should create single-tile plateaus but they're rare/not appearing as expected
- Fix grids with no buildings - Buildings only spawn on grass adjacent to roads
- Place house on road dead-ends - Road end tiles should get a building
- after replacing a tile, check if dec needs to be removed.

- update mesh colors in blender png
- remove baked shadoews from blender file?

- add snowy areas?
- post - add subtle tilt shift, bleach,grain, LUT
- add extra tile with just 1 small bit of hill to fill jagged gaps in cliffs?(like coast)
- paint big noise color fileds over grasss for more variation
- find/make simpler house models
- fix weird ocean walls
- add boats + carts?
- add birds + clouds?
- add better skybox - styormy skies
- make tile hex edges less deep/visible in blender?
- Update to latest threejs
- add dec to hide road/river discontuities? Add a big house/watermill?
