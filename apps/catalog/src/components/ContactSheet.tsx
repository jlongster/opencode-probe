import { useEffect, useEffectEvent, useRef } from "react"
import type { Screen } from "../catalog"
import { frameFor } from "../catalog"
import { IdChip } from "./IdChip"
import { TerminalFrame } from "./TerminalFrame"

interface ContactSheetProps {
  readonly screens: ReadonlyArray<Screen>
  readonly selectedId: string | undefined
  readonly focusTick: number
  readonly keyboardEnabled: boolean
  readonly variantId: string
  readonly onSelect: (id: string) => void
  readonly onOpen: (id: string) => void
}

export function ContactSheet({
  screens,
  selectedId,
  focusTick,
  keyboardEnabled,
  variantId,
  onSelect,
  onOpen,
}: ContactSheetProps) {
  const gridRef = useRef<HTMLElement>(null)
  const focusedTick = useRef(0)

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (screens.length === 0) return
    const target = event.target
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    if (editing) return
    const columns = gridColumns(gridRef.current)
    const steps: Record<string, number> = {
      ArrowUp: -columns,
      ArrowDown: columns,
    }
    const current = Math.max(
      0,
      screens.findIndex((screen) => screen.id === selectedId),
    )
    let next: number | undefined
    if (event.key === "Home") next = 0
    if (event.key === "End") next = screens.length - 1
    const step = steps[event.key]
    if (step !== undefined) next = Math.min(screens.length - 1, Math.max(0, current + step))
    if (next === undefined) return
    event.preventDefault()
    const screen = screens[next]
    if (screen) onSelect(screen.id)
  })

  useEffect(() => {
    if (!keyboardEnabled) return
    const listener = (event: KeyboardEvent) => handleKeyDown(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [keyboardEnabled])

  useEffect(() => {
    if (focusTick === focusedTick.current) return
    focusedTick.current = focusTick
    if (selectedId === undefined) return
    const card = gridRef.current?.querySelector<HTMLElement>(`[data-screen="${CSS.escape(selectedId)}"]`)
    card?.focus()
  }, [focusTick, selectedId])

  return (
    <section className="contact-sheet" aria-label="Terminal captures" ref={gridRef}>
      {screens.length === 0 ? (
        <p className="empty-state">No captures match.</p>
      ) : (
        screens.map((screen) => {
          const frame = frameFor(screen, variantId)
          return (
            <article
              key={screen.id}
              className={`capture-card${screen.id === selectedId ? " selected" : ""}`}
            >
              <button
                type="button"
                data-screen={screen.id}
                className="capture-open"
                tabIndex={screen.id === selectedId ? 0 : -1}
                aria-label={`Open ${screen.title}`}
                onClick={() => onOpen(screen.id)}
                onFocus={() => {
                  if (screen.id !== selectedId) onSelect(screen.id)
                }}
              >
                <span className="capture-frame">
                  <TerminalFrame frame={frame} label={screen.title} lazy />
                </span>
              </button>
              <footer className="capture-caption">
                <span className="capture-title">{screen.title}</span>
                <IdChip id={screen.id} />
              </footer>
            </article>
          )
        })
      )}
    </section>
  )
}

function gridColumns(grid: HTMLElement | null): number {
  if (!grid) return 1
  return getComputedStyle(grid).gridTemplateColumns.split(" ").length
}
