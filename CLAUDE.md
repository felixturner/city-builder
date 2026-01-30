# Project Notes

Converting this repo into a city builder toy.

## Instructions

- Don't ask leading questions about next steps
- Play audio voice notification when done with tasks

## TODO

- [ ] Fix FXAA on resize - use DPR approach from tsl-pills project (or femove FXAA)
- [ ] Dynamic AO blur based on zoom - reduce blur when zoomed out, increase when zoomed in
- [ ] Add three-point lighting? (key, fill, rim lights)
- [ ] add UI to zoom/pan on desktop/ mobile. Townscaper: left click drag - pan. left click - add block. scroll wheel zoom. right click rotate. right click destroy
- [ ] Clone to new repo. setup vite build with github pages
- [ ] Update to latest threejs
- [ ] add dynamic windows/lights
- [ ] add floor grid and UI like https://robot.co/playground/grid
- [ ] click to destroy / build buildings (like townscaper) https://oskarstalberg.com/Townscaper/
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
