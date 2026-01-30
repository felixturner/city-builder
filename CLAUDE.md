# Project Notes

Converting this repo into a city builder toy.

## Instructions

- Don't ask leading questions about next steps
- Play audio voice notification when done with tasks

## TODO

- [ ] Fix AO flicker on pan when zoomed out
- [ ] Dial in AO
- [ ] Rotate some blocks?
- [ ] Smooth camera zoom
- [ ] Stack multiple floor blocks for tall towers (instead of stretched single block)
- [ ] add dynamic windows/lights
- [ ] click to destroy / build buildings (like townscaper) https://oskarstalberg.com/Townscaper/
- [ ] Fix FXAA on resize - use DPR approach from tsl-pills project (or remove FXAA)
- [ ] Dynamic AO blur based on zoom - reduce blur when zoomed out, increase when zoomed in
- [ ] Add three-point lighting? (key, fill, rim lights)
- [ ] Update to latest threejs
- [ ] add floor grid and UI like https://robot.co/playground/grid
- [ ] Setup Netlify deploy (alternative to GitHub Pages)
- [ ] subtle sound effects
- [ ] day/night toggle (move dir light / fade between HDRs)
- [ ] roads / cars
- [ ] create my own roof tiles in blender or get from a pack.
- [ ] add subtle noise grain etc?

## Done

- [x] Fix AO - was using computed normals, switched back to normalView
- [x] Fix shadow clipping - light-space AABB calculation, dynamic shadow frustum based on camera zoom
- [x] Split up code into more files (Demo.js, GUI.js, CityBuilder.js, Lighting.js)
- [x] Deformed grid like Townscaper (DeformableGrid.js, GridRenderer.js) - vertex-based grid with noise deformation, relaxation, edge pinning, blue ground grid visualization
- [x] Fix mobile touch controls - correct TOUCH constant values
- [x] Fix shadow clipping on mobile portrait - use max of vertical/horizontal frustum extent
- [x] Add HDR rotation controls - custom TSL environment node for WebGPU (background + material reflections)
