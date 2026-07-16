import { fileURLToPath } from "node:url"
import { GlobalFonts, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas"
import { TextStyle, type CapturedFrame } from "./types.js"

export const CellWidth = 10
export const CellHeight = 20
const FontSize = 16
const FontFamily = "OpenCode Mono"
const SymbolFontFamily = "OpenCode Symbols"

const fontOverride = process.env["OPENCODE_DRIVE_FONT"]
const fontFiles = fontOverride
  ? fontOverride
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
  : [
      "CommitMono-400-Regular.otf",
      "CommitMono-700-Regular.otf",
      "CommitMono-400-Italic.otf",
      "CommitMono-700-Italic.otf",
    ].map((file) => fileURLToPath(new URL(`../../assets/fonts/commit-mono/${file}`, import.meta.url)))

if (fontFiles.length === 0)
  throw new Error("OPENCODE_DRIVE_FONT must contain at least one font file")
for (const file of fontFiles) {
  if (!GlobalFonts.registerFromPath(file, FontFamily))
    throw new Error(`Failed to register capture font: ${file}`)
}
for (const file of [
  "noto-sans-symbols-2-symbols-400-normal.woff2",
  "noto-sans-symbols-2-braille-400-normal.woff2",
]) {
  const path = fileURLToPath(import.meta.resolve(`@fontsource/noto-sans-symbols-2/files/${file}`))
  if (!GlobalFonts.registerFromPath(path, SymbolFontFamily))
    throw new Error(`Failed to register capture symbol font: ${path}`)
}

function color(rgb: number, alpha = 1) {
  return `rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${alpha})`
}

const baselineCache = new Map<string, number>()

type Measurable = {
  measureText(text: string): {
    readonly fontBoundingBoxAscent?: number
    readonly fontBoundingBoxDescent?: number
  }
}

function baselineOffset(context: Measurable, font: string) {
  const cached = baselineCache.get(font)
  if (cached !== undefined) return cached
  const metrics = context.measureText("Mg")
  const ascent = metrics.fontBoundingBoxAscent ?? FontSize * 0.8
  const descent = metrics.fontBoundingBoxDescent ?? FontSize * 0.2
  // Center the font's bounding box in the cell and return its alphabetic baseline.
  const offset = (CellHeight - (ascent + descent)) / 2 + ascent
  baselineCache.set(font, offset)
  return offset
}

function drawFixedGlyph(context: SKRSContext2D, char: string, x: number, y: number) {
  if (char === "█") context.fillRect(x, y, CellWidth, CellHeight)
  else if (char === "▀") context.fillRect(x, y, CellWidth, CellHeight / 2)
  else if (char === "▄") context.fillRect(x, y + CellHeight / 2, CellWidth, CellHeight / 2)
  else if (char === "■") context.fillRect(x + 1, y + 6, 8, 8)
  else if (char === "⬝") context.fillRect(x + 4, y + 9, 2, 2)
  else if (char === "↳") {
    context.fillRect(x + 1, y + 4, 1, 10)
    context.fillRect(x + 1, y + 13, 8, 1)
    context.fillRect(x + 6, y + 11, 1, 1)
    context.fillRect(x + 7, y + 12, 1, 1)
    context.fillRect(x + 7, y + 14, 1, 1)
    context.fillRect(x + 6, y + 15, 1, 1)
  }
  else return false
  return true
}

export interface RenderFrameOptions {
  readonly cols?: number
  readonly rows?: number
  readonly header?: string
}

export function renderFrame(frame: CapturedFrame, options: RenderFrameOptions = {}): Buffer {
  const cols = Math.max(frame.cols, options.cols ?? frame.cols)
  const rows = Math.max(frame.rows, options.rows ?? frame.rows)
  const headerHeight = options.header ? 40 : 0
  const canvas = createCanvas(cols * CellWidth, rows * CellHeight + headerHeight)
  const context = canvas.getContext("2d")
  context.fillStyle = "#080808"
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (options.header) {
    context.fillStyle = "#151515"
    context.fillRect(0, 0, canvas.width, headerHeight)
    context.font = `700 ${FontSize}px "${FontFamily}", "${SymbolFontFamily}"`
    context.fillStyle = "#d8d8d8"
    context.textBaseline = "middle"
    context.textAlign = "left"
    context.fillText(options.header, 16, headerHeight / 2, canvas.width - 32)
  }
  context.textBaseline = "alphabetic"
  context.textAlign = "center"

  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const inverse = Boolean(span.attributes & TextStyle.inverse)
      const hidden = Boolean(span.attributes & TextStyle.invisible)
      const foreground = inverse ? span.bg : span.fg
      const background = inverse ? span.fg : span.bg
      const y = headerHeight + row * CellHeight
      context.fillStyle = color(background)
      context.fillRect(column * CellWidth, y, span.width * CellWidth, CellHeight)
      if (hidden) {
        column += span.width
        continue
      }
      const italic = span.attributes & TextStyle.italic ? "italic " : ""
      const weight = span.attributes & TextStyle.bold ? "700 " : "400 "
      const font = `${italic}${weight}${FontSize}px "${FontFamily}", "${SymbolFontFamily}"`
      context.font = font
      context.fillStyle = color(foreground, span.attributes & TextStyle.dim ? 0.55 : 1)
      const baseline = baselineOffset(context, font)
      let remaining = span.width
      for (const char of span.text) {
        const cells = Math.min(Math.max(1, Bun.stringWidth(char)), remaining)
        const x = column * CellWidth
        if (!drawFixedGlyph(context, char, x, y))
          context.fillText(
            char,
            x + (cells * CellWidth) / 2,
            y + baseline,
            cells * CellWidth,
          )
        if (span.attributes & TextStyle.underline) {
          context.fillRect(x, y + 17, cells * CellWidth, 1)
        }
        if (span.attributes & TextStyle.strikethrough) {
          context.fillRect(x, y + 10, cells * CellWidth, 1)
        }
        column += cells
        remaining -= cells
      }
      if (remaining > 0) {
        column += remaining
      }
    }
  })

  if (frame.cursor.visible && frame.cursor.row >= 0 && frame.cursor.row < frame.rows) {
    context.strokeStyle = "#d8d8d8"
    context.lineWidth = 2
    context.strokeRect(
      frame.cursor.col * CellWidth + 1,
      headerHeight + frame.cursor.row * CellHeight + 1,
      CellWidth - 2,
      CellHeight - 2,
    )
  }
  return canvas.toBuffer("image/png")
}

export async function joinFrames(left: Buffer, right: Buffer): Promise<Buffer> {
  const [leftImage, rightImage] = await Promise.all([loadImage(left), loadImage(right)])
  if (leftImage.height !== rightImage.height)
    throw new Error(
      `comparison recordings must have the same height: ${leftImage.height} !== ${rightImage.height}`,
    )
  const canvas = createCanvas(leftImage.width + rightImage.width, leftImage.height)
  const context = canvas.getContext("2d")
  context.drawImage(leftImage, 0, 0)
  context.drawImage(rightImage, leftImage.width, 0)
  return canvas.toBuffer("image/png")
}
