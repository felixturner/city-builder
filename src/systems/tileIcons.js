import { Tower } from '../Tower.js'
import { TetrominoGeometry } from '../lib/TetrominoGeometry.js'
import { TopType, isGenerator, isTurret, isBarracks, isShield } from '../blockTypes.js'
import { SHIELD_LINE } from '../palette.js'

// Icon geometry, shared with the tray DOM that hosts these canvases.
export const ICON = 72 // palette icon canvas size (px)
export const CELL = 20 // px per footprint cell (rects); tetrominoes shrink to fit

/**
 * Everything drawn INTO a palette slot's 2D canvas.
 *
 * Pulled out of TilePalette, which was doing three jobs at once: pointer/drag
 * handling, tray DOM, and this. These are pure canvas functions - hand them a
 * context and a tile and they draw it - so they carry no palette state and are
 * the easiest part of the file to reason about in isolation.
 *
 * `accents` is city.accentColors, the only outside thing an icon needs.
 */

/** Width/height in cells of a cell-offset list. */
export function cellBounds(cells) {
  let w = 0, h = 0
  for (const [x, y] of cells) { w = Math.max(w, x + 1); h = Math.max(h, y + 1) }
  return [w, h]
}

/** CSS colour for a tile's icon. */
export function tileColor(tile, accents) {
  if (tile.wall) return `#${Tower.COLORS[tile.topColorIndex].getHexString()}`
  if (isShield(tile)) return SHIELD_LINE
  if (isGenerator(tile)) return `#${accents[tile.colorIndex].getHexString()}`
  if (isTurret(tile) || isBarracks(tile)) return '#9aa0aa'
  return `#${Tower.COLORS[tile.topColorIndex].getHexString()}`
}

export function drawTile(slot, accents) {
  const ctx = slot.canvas.getContext('2d')
  ctx.clearRect(0, 0, ICON, ICON)
  const tile = slot.tile
  if (!tile) return
  if (tile.wall) { drawTetromino(ctx, tile, accents); return }
  drawRectTile(ctx, tile, accents)
}

/** Grey tetromino: filled cells with per-cell outlines (rotation 0). */
function drawTetromino(ctx, tile, accents) {
  const states = TetrominoGeometry.states[tile.shapeName]
  // RAW state, deliberately not placeCells(). placeOrient's 90deg turn exists
  // to cancel how the isometric camera maps world axes to the screen, so the
  // board reads the same as this flat icon. Applying it here too double-counts
  // it and the placed tile comes out a quarter turn off.
  const cells = states[(tile.rot || 0) % states.length]
  const [w, h] = cellBounds(cells)
  const c = Math.min(CELL, (ICON - 8) / Math.max(w, h))
  const ox = (ICON - w * c) / 2
  const oy = (ICON - h * c) / 2
  ctx.fillStyle = tileColor(tile, accents)
  for (const [cx, cy] of cells) ctx.fillRect(ox + cx * c, oy + cy * c, c, c)
  ctx.strokeStyle = 'rgba(0,0,0,0.28)'
  ctx.lineWidth = 1
  for (const [cx, cy] of cells) ctx.strokeRect(ox + cx * c + 0.5, oy + cy * c + 0.5, c - 1, c - 1)
}


function drawRectTile(ctx, tile, accents) {
  const fw = tile.w * CELL
  const fh = tile.h * CELL
  const ox = (ICON - fw) / 2
  const oy = (ICON - fh) / 2
  const cx = ICON / 2
  const cy = ICON / 2
  const m = Math.min(fw, fh)
  const raised = 'rgba(255,255,255,0.32)'
  const recess = 'rgba(0,0,0,0.3)'

  ctx.fillStyle = tileColor(tile, accents)
  ctx.fillRect(ox, oy, fw, fh)

  if (tile.typeTop === TopType.SHIELD) {
    // Hole top, same as the king: a dark through-hole in the accent square.
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2); ctx.fill()
  } else if (tile.typeTop === TopType.BARRACKS) {
    // Grey divot top with the little lookout soldier sitting in it.
    ctx.fillStyle = recess
    ctx.beginPath(); ctx.arc(cx, cy, m * 0.26, 0, Math.PI * 2); ctx.fill()
    const s = m * 0.13
    ctx.fillStyle = raised
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(Math.PI / 4) // same quarter-turn stance the soldier mesh keeps
    ctx.fillRect(-s, -s, s * 2, s * 2)
    ctx.restore()
  } else if (tile.typeTop === TopType.PATH_GENERATOR) {
    const pe = m * 0.28, pt = m * 0.1
    ctx.fillStyle = recess
    ctx.fillRect(cx - pe, cy - pt, pe * 2, pt * 2)
    ctx.fillRect(cx - pt, cy - pe, pt * 2, pe * 2)
  } else if (tile.typeTop === TopType.PEG_TURRET || tile.typeTop === TopType.DIVOT_TURRET || tile.typeTop === TopType.MORTAR_TURRET) {
    const r = m * 0.26
    ctx.fillStyle = tile.typeTop === TopType.PEG_TURRET ? raised : recess
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r * 0.87, cy + r * 0.5)
    ctx.lineTo(cx - r * 0.87, cy + r * 0.5)
    ctx.closePath()
    ctx.fill()
    // Mortar: a lobbed shell dot above the barrel.
    if (tile.typeTop === TopType.MORTAR_TURRET) {
      ctx.fillStyle = recess
      ctx.beginPath(); ctx.arc(cx, cy - r * 0.9, m * 0.1, 0, Math.PI * 2); ctx.fill()
    }
  } else if (tile.typeTop === TopType.ENCLOSURE_GENERATOR) {
    // Peg disc reads purely via its drop shadow (same colour as the tile).
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.8)'
    ctx.shadowBlur = m * 0.16
    ctx.shadowOffsetY = m * 0.07
    ctx.fillStyle = tileColor(tile, accents)
    ctx.beginPath(); ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  if ((tile.w > 1 || tile.h > 1) && tile.typeTop !== TopType.PATH_GENERATOR) {
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'
    ctx.lineWidth = 1
    for (let i = 1; i < tile.w; i++) {
      ctx.beginPath(); ctx.moveTo(ox + i * CELL, oy); ctx.lineTo(ox + i * CELL, oy + fh); ctx.stroke()
    }
    for (let j = 1; j < tile.h; j++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + j * CELL); ctx.lineTo(ox + fw, oy + j * CELL); ctx.stroke()
    }
  }
}

/** Clockwise ring timer on the slot canvas (matches the build-wheel). */
export function drawRing(slot, p) {
  const ctx = slot.canvas.getContext('2d')
  ctx.clearRect(0, 0, ICON, ICON)
  const cx = ICON / 2, cy = ICON / 2
  const rO = ICON * 0.32, rI = ICON * 0.21
  const start = -Math.PI / 2
  ctx.beginPath()
  ctx.arc(cx, cy, rO, 0, Math.PI * 2)
  ctx.arc(cx, cy, rI, Math.PI * 2, 0, true)
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fill('evenodd')
  const end = start + Math.max(0.0001, p) * Math.PI * 2
  ctx.beginPath()
  ctx.arc(cx, cy, rO, start, end, false)
  ctx.arc(cx, cy, rI, end, start, true)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.fill()
}
