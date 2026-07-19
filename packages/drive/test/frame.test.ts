import { describe, expect, it } from "vitest"
import {
  BlockGlyphs,
  CellHeight,
  CellWidth,
  TextStyle,
  drawBlockGlyph,
} from "../src/frame/index.js"

describe("frame geometry", () => {
  it("draws exactly the geometric block and bar primitives", () => {
    expect(Object.keys(BlockGlyphs).sort()).toEqual(["█", "▀", "▄", "┃", "╹"].sort())
  })

  it("keeps every glyph rectangle inside one cell", () => {
    for (const glyph of Object.values(BlockGlyphs)) {
      expect(glyph.x).toBeGreaterThanOrEqual(0)
      expect(glyph.x + glyph.width).toBeLessThanOrEqual(CellWidth)
      expect(glyph.y + glyph.height).toBeLessThanOrEqual(CellHeight)
    }
  })

  it("stretches solid blocks across cells but keeps bars centered", () => {
    const rects: Array<readonly [number, number, number, number]> = []
    const context = {
      fillRect: (x: number, y: number, width: number, height: number) =>
        void rects.push([x, y, width, height]),
    }
    expect(drawBlockGlyph(context, "█", 0, 0, 2)).toBe(true)
    expect(drawBlockGlyph(context, "┃", 0, 0, 2)).toBe(true)
    expect(drawBlockGlyph(context, "a", 0, 0)).toBe(false)
    expect(rects).toEqual([
      [0, 0, 2 * CellWidth, CellHeight],
      [CellWidth / 2 - 1, 0, 2, CellHeight],
    ])
  })

  it("draws diagonal quadrant blocks edge-to-edge", () => {
    const rects: Array<readonly [number, number, number, number]> = []
    const context = {
      fillRect: (x: number, y: number, width: number, height: number) =>
        void rects.push([x, y, width, height]),
    }
    expect(drawBlockGlyph(context, "▚", 0, 0)).toBe(true)
    expect(drawBlockGlyph(context, "▞", CellWidth, 0)).toBe(true)
    expect(rects).toEqual([
      [0, 0, CellWidth / 2, CellHeight / 2],
      [CellWidth / 2, CellHeight / 2, CellWidth / 2, CellHeight / 2],
      [CellWidth + CellWidth / 2, 0, CellWidth / 2, CellHeight / 2],
      [CellWidth, CellHeight / 2, CellWidth / 2, CellHeight / 2],
    ])
  })

  it("uses distinct attribute bits", () => {
    const bits = Object.values(TextStyle)
    expect(new Set(bits).size).toBe(bits.length)
    for (const bit of bits) expect(bit & (bit - 1)).toBe(0)
  })
})
