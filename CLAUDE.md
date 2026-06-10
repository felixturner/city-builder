# Project Notes

a city builder toy.

## Critical Rules (ALWAYS follow)

1. **NEVER** git revert, commit, or push without asking for explicit permission first. No exceptions.
2. **NEVER** make code changes unless I specifically ask you to. If I ask a question, just answer it.
3. **ALWAYS** play audio notification (`afplay /System/Library/Sounds/Glass.aiff`) after completing ANY task or before asking ANY question. Every single response.

## Other Instructions

- Do not present guesses as facts. If you don't know something, say so.
- Don't ask leading questions about next steps

## TODO

- [ ] Improve neighbour lot spawn so growth is directional, not all-4-neighbours-at-once. Currently a dormant lot's progress = whole `lotStrength` of each active neighbour lot (City.js `activeNeighbourStrength`), so the center lot feeds all 4 empties equally and they spawn together. Cheap fix (A): weight each neighbour by the strength of the blocks along the shared border edge only, so growth flows toward where you built. Bigger option (B): true block-level sprawl (dissolves lot identity/color/outline/plus-block — see gameplay.md §8). Perf is a non-issue either way (event-driven via onTowerChanged, not per-frame).
- [ ] Tilt only the turret barrel up/down to match shot direction (not the whole model). Needs turrets.blend re-exported with the barrel as its own object/pivot — currently turrets.glb splits each turret by material (Blosm/DarkDetail/MainBody/RedDetail), not by part, so there's no barrel node to rotate.
- [ ] Consider manual compositing passes instead of MRT (fixes transparency, enables half-res AO for perf)
- [ ] Fix AO flicker on pan when zoomed out
- [ ] Dial in AO (some AO is banding)
- [ ] Rotate some blocks?
- [ ] Smooth camera zoom
- [ ] add dynamic windows/lights
- [ ] Dynamic AO blur based on zoom - reduce blur when zoomed out, increase when zoomed in
- [ ] Add three-point lighting? (key, fill, rim lights)
- [ ] Update to latest threejs
- [ ] add floor grid and UI like https://robot.co/playground/grid
- [ ] Setup Netlify deploy (alternative to GitHub Pages)
- [ ] day/night toggle (move dir light / fade between HDRs)
- [ ] roads / cars
- [ ] create my own roof tiles in blender or get from a pack. (look at lego blocks)
- [ ] add subtle noise grain etc?
- [ ] click and drag to move buildings?

## Done

- [x] Fix AO - was using computed normals, switched back to normalView
- [x] Fix shadow clipping - light-space AABB calculation, dynamic shadow frustum based on camera zoom
- [x] Split up code into more files (Demo.js, GUI.js, CityBuilder.js, Lighting.js)
- [x] Deformed grid like Townscaper (DeformableGrid.js, GridRenderer.js) - vertex-based grid with noise deformation, relaxation, edge pinning, blue ground grid visualization
- [x] Fix mobile touch controls - correct TOUCH constant values
- [x] Fix shadow clipping on mobile portrait - use max of vertical/horizontal frustum extent
- [x] Add HDR rotation controls - custom TSL environment node for WebGPU (background + material reflections)
- [x] Stack multiple floor blocks for tall towers (instead of stretched single block)
- [x] click to destroy / build buildings (like townscaper)
- [x] subtle sound effects

## Naming Conventions

- **City** - The entire grid, comprised of 11x11 lots
- **Lot** - A 10x10 grid of cells containing towers (separated by 3-cell roads)
- **Cell** - A 1x1 grid unit, the size of the smallest block
- **Tower** - A building/stack made of multiple blocks. Has position, rotation, height, colors. (class: `Tower`)
- **Block** - An individual mesh instance within a tower
  - **Base Block** - Floor/body block geometry (typeBottom: 0-8)
  - **Top Block** - Roof block geometry (typeTop: 0-5)
- **Floor** - One level of a tower, rendered as a base block instance

