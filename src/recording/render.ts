import { fileURLToPath } from "node:url"
import { GlobalFonts, createCanvas } from "@napi-rs/canvas"
import { TextStyle, type CapturedFrame } from "./types.js"

const CellWidth = 10
const CellHeight = 20
const FontSize = 16
const FontFamily = "OpenCode Mono"

for (const file of [
  "adwaita-mono-latin-400-normal.woff2",
  "adwaita-mono-latin-700-normal.woff2",
  "adwaita-mono-latin-400-italic.woff2",
  "adwaita-mono-latin-700-italic.woff2",
]) {
  GlobalFonts.registerFromPath(
    fileURLToPath(import.meta.resolve(`@fontsource/adwaita-mono/files/${file}`)),
    FontFamily,
  )
}

function color(rgb: number, alpha = 1) {
  return `rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${alpha})`
}

export interface RenderFrameOptions {
  readonly cols?: number
  readonly rows?: number
}

export function renderFrame(frame: CapturedFrame, options: RenderFrameOptions = {}): Buffer {
  const cols = Math.max(frame.cols, options.cols ?? frame.cols)
  const rows = Math.max(frame.rows, options.rows ?? frame.rows)
  const canvas = createCanvas(cols * CellWidth, rows * CellHeight)
  const context = canvas.getContext("2d")
  context.fillStyle = "#080808"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = "top"

  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const inverse = Boolean(span.attributes & TextStyle.inverse)
      const hidden = Boolean(span.attributes & TextStyle.invisible)
      const foreground = inverse ? span.bg : span.fg
      const background = inverse ? span.fg : span.bg
      let remaining = span.width
      for (const char of span.text) {
        const cells = Math.min(Math.max(1, Bun.stringWidth(char)), remaining)
        context.fillStyle = color(background)
        context.fillRect(column * CellWidth, row * CellHeight, cells * CellWidth, CellHeight)
        if (!hidden) {
          const italic = span.attributes & TextStyle.italic ? "italic " : ""
          const weight = span.attributes & TextStyle.bold ? "700 " : "400 "
          context.font = `${italic}${weight}${FontSize}px "${FontFamily}"`
          context.fillStyle = color(foreground, span.attributes & TextStyle.dim ? 0.55 : 1)
          context.fillText(char, column * CellWidth, row * CellHeight + 1)
          if (span.attributes & TextStyle.underline) {
            context.fillRect(column * CellWidth, row * CellHeight + 17, cells * CellWidth, 1)
          }
          if (span.attributes & TextStyle.strikethrough) {
            context.fillRect(column * CellWidth, row * CellHeight + 10, cells * CellWidth, 1)
          }
        }
        column += cells
        remaining -= cells
      }
      if (remaining > 0) {
        context.fillStyle = color(background)
        context.fillRect(column * CellWidth, row * CellHeight, remaining * CellWidth, CellHeight)
        column += remaining
      }
    }
  })

  if (frame.cursor.visible && frame.cursor.row >= 0 && frame.cursor.row < frame.rows) {
    context.strokeStyle = "#d8d8d8"
    context.lineWidth = 2
    context.strokeRect(
      frame.cursor.col * CellWidth + 1,
      frame.cursor.row * CellHeight + 1,
      CellWidth - 2,
      CellHeight - 2,
    )
  }
  return canvas.toBuffer("image/png")
}
