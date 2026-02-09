# Seed Dropping Investigation

## Reproduction
- **Seed**: 274707
- **Failing grid**: [1,-1] (27 seeds from 3 neighbors)

### Click order to reproduce:
1. `[0,0]` - Center (auto)
2. `[-1,-1]` - 9 seeds, success
3. `[-1,0]` - 18 seeds, success
4. `[0,1]` - 18 seeds, success
5. `[1,0]` - 18 seeds, success
6. `[0,-1]` - 18 seeds, success
7. `[1,-1]` - 27 seeds, **FAILS**

### Failure pattern:
- Cell (7,-10) fails repeatedly
- 10 seeds dropped but none fix the issue
- Dropped seeds are scattered, not near (7,-10)

## Root Cause Analysis

### Why wrong seeds are dropped:
1. `findAdjacentSeeds()` looks for seeds **directly adjacent** to failed cell
2. No seeds are directly adjacent to (7,-10)
3. Falls back to dropping **random** seeds
4. Real problem: seeds whose **propagated constraints** conflict at (7,-10)

### The 3-grid junction problem:
Grid [1,-1] borders:
- [0,0] (center) - seeds on SE edge
- [1,0] - seeds on S edge
- [0,-1] - seeds on E edge

These 3 seed sources create constraints that propagate inward and conflict at corner cells like (7,-10).

## Potential Fixes

### Option 1: Trace propagation back to source seeds
Instead of finding seeds adjacent to failed cell, find seeds whose constraints reached the failed cell through propagation.

**Approach:**
- When propagation fails at cell X, look at X's neighbors
- For each collapsed neighbor, check if it was a seed or collapsed by WFC
- If collapsed by WFC, trace back through its constraining neighbors
- Drop the seed at the root of the constraint chain

**Pros:** Targets actual problem seeds
**Cons:** Complex to implement, need to track constraint sources

### Option 2: Pre-validate corner cells before WFC
Identify cells that receive constraints from 2+ different source grids (corner cells). Before running WFC, check if any tile can satisfy all incoming edge requirements.

**Approach:**
- After collecting seeds, identify cells adjacent to seeds from different grids
- For each such cell, compute intersection of compatible tiles
- If intersection is empty, try replacing one of the constraining seeds

**Pros:** Catches problems before WFC runs
**Cons:** Doesn't help if conflict is deeper (2+ cells from seeds)

### Option 3: Drop seeds nearest to failed cell
Instead of random fallback, drop the seed with smallest distance to the failed cell.

**Approach:**
- When no adjacent seeds found, compute distance from each seed to failed cell
- Drop the closest seed first

**Pros:** Simple to implement
**Cons:** Still might not find the right seed if problem is complex

### Option 4: Constraint relaxation
When a cell has 0 possibilities, instead of failing, relax constraints by allowing grass edges to connect to anything.

**Pros:** Might produce a valid (if imperfect) result
**Cons:** Could create visual discontinuities

### Option 5: Seed priority/importance scoring
Score seeds by how "constraining" they are (non-grass edges = higher score). Drop least important seeds first.

**Pros:** Preserves roads/rivers, sacrifices grass edges
**Cons:** Doesn't guarantee fixing the actual problem

## Recommended Approach

**Combine Options 2 + 3:**
1. Pre-validate cells adjacent to multiple seed sources (Option 2)
2. When WFC fails, drop nearest seed to failed cell (Option 3)
3. Track which grids each seed came from to prioritize dropping seeds from grids with most seeds

This addresses the immediate problem (wrong seeds dropped) while also catching some conflicts earlier.
