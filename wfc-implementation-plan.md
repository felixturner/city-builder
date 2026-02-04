# WFC Road Generation Implementation Plan

## Summary

Implement a classical Wave Function Collapse algorithm for road tile generation, replacing the current "grow from center" approach with a constraint-propagation system.

## Key Concepts

**WFC Algorithm Flow:**
1. Initialize all cells with all possible (tile, rotation) states
2. Pick cell with lowest entropy (fewest possibilities)
3. Collapse it to one random state (weighted by frequency)
4. Propagate constraints to neighbors (remove incompatible states)
5. Repeat until all collapsed or contradiction detected
6. On contradiction: backtrack or restart

## Files to Create/Modify

### New: `src/WFC.js`

Contains three classes:

**WFCCell** - Tracks possibility space for one grid cell
- `possibilities: Set<string>` - Set of `"type_rotation"` keys still valid
- `collapsed: boolean` / `tile: {type, rotation}`
- `entropy` getter - `log(count) + noise` for tie-breaking

**WFCAdjacencyRules** - Pre-computed tile compatibility
- `allowed: Map<stateKey, {N,E,S,W: Set<stateKey>}>` - What each state allows in each direction
- `static fromTileDefinitions()` - Build rules by checking if `exitsA[dir] === exitsB[opposite]`

**WFCSolver** - Main algorithm
- `grid: WFCCell[][]`, `rules`, `propagationStack`, `history` (for backtracking)
- `init()` - Fill all cells with all 24 states (6 tiles × 4 rotations)
- `findLowestEntropyCell()` - Return uncollapsed cell with min entropy
- `collapse(x, z)` - Save state, pick weighted random, mark collapsed
- `propagate()` - Remove invalid possibilities from neighbors, cascade
- `solve()` - Main loop: collapse → propagate → repeat
- `backtrack()` - Restore previous state on contradiction

### Modify: `src/City.js`

Add method:
```javascript
generateRoadsWFC(maxTiles, layer = 0, options = {}) {
  // Build rules once (cache in this.wfcRules)
  // Create WFCSolver with tile weights
  // solver.solve() returns array of {gridX, gridZ, type, rotation}
  // Call placeRoadTile() for each result
  // Fallback to generateRandomRoads() if WFC fails
}
```

Update `initRoadGrid()` to call `generateRoadsWFC()` when enabled.

### Modify: `src/GUI.js`

Add to roads folder:
- `useWFC: boolean` - Toggle between algorithms
- `wfcSeed: number` - Seed for reproducible generation

## Adjacency Rule Generation

From `TileDefinitions`, for each pair of (stateA, stateB):
- Get exits for stateA at its rotation
- Get exits for stateB at its rotation
- For each direction (N,E,S,W): if `exitsA[dir] === exitsB[opposite]`, they're compatible

Example: FORWARD rot=0 has exits {N:true, S:true} → allows FORWARD rot=0 in N/S directions.

## Tile Weights (configurable)

```javascript
{
  FORWARD: 60,  // Straights common
  TURN_90: 20,  // Turns less common
  T: 15,        // T-junctions rare
  X: 5,         // Crossings rare
  END: 10,      // Caps as needed
  ANGLE: 10
}
```

## Backtracking Strategy

- Save full grid state before each collapse
- On contradiction (cell has 0 possibilities): restore last state, remove the choice that failed
- Limit backtrack attempts (default: 50) to prevent infinite loops
- If limit exceeded: restart or fall back to current algorithm

## Verification Steps

1. **Visual check**: All tiles connect (no gaps at edges)
2. **Console log**: Number of tiles placed, backtrack count
3. **Seed test**: Same seed produces identical layout
4. **Toggle test**: Switch between WFC and current algorithm via GUI

## Sources

- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) - Original implementation
- [gridbugs.org WFC tutorial](https://www.gridbugs.org/wave-function-collapse/) - Algorithm details
- [Boris the Brave - WFC tips](https://www.boristhebrave.com/2020/02/08/wave-function-collapse-tips-and-tricks/) - Practical advice
