import { useEffect, useEffectEvent, useRef } from "react"
import type { Facet, Filter, Screen, Taxonomy, TaxonomyGroup, Variant } from "../catalog"
import { facetValues, frameFor, label, taxonomyLabel } from "../catalog"
import { IdChip } from "./IdChip"
import { TerminalFrame } from "./TerminalFrame"

interface ViewerProps {
  readonly screen: Screen
  readonly identifier: string
  readonly variant: Variant
  readonly variantPosition: number
  readonly variantTotal: number
  readonly screenTaxonomy: ReadonlyArray<TaxonomyGroup>
  readonly uiElementTaxonomy: ReadonlyArray<TaxonomyGroup>
  readonly position: number
  readonly total: number
  readonly active: boolean
  readonly onClose: () => void
  readonly onNavigate: (direction: 1 | -1) => void
  readonly onVariant: (direction: 1 | -1) => void
  readonly onFacet: (filter: Filter) => void
  readonly onTaxonomy: (taxonomy: Taxonomy, value: string) => void
}

const facetOrder: ReadonlyArray<Facet> = ["surface", "pattern", "feature", "state"]

export function Viewer({
  screen,
  identifier,
  variant,
  variantPosition,
  variantTotal,
  screenTaxonomy,
  uiElementTaxonomy,
  position,
  total,
  active,
  onClose,
  onNavigate,
  onVariant,
  onFacet,
  onTaxonomy,
}: ViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const frame = frameFor(screen, variant.id)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      onNavigate(event.key === "ArrowLeft" ? -1 : 1)
      return
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      onVariant(event.key === "ArrowUp" ? -1 : 1)
    }
  })

  useEffect(() => {
    if (!active) return
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [active])

  return (
    <dialog
      ref={dialogRef}
      className="viewer"
      aria-label={screen.title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className="viewer-header">
        <button type="button" className="viewer-button" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
        <span className="viewer-position">
          <button type="button" className="viewer-button" onClick={() => onNavigate(-1)} aria-label="Previous flow step">←</button>
          {String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}
          <button type="button" className="viewer-button" onClick={() => onNavigate(1)} aria-label="Next flow step">→</button>
        </span>
        <div className="viewer-actions">
          <IdChip id={identifier} className="viewer-button" />
          <button type="button" className="viewer-button" onClick={() => onVariant(-1)} aria-label="Previous variant">←</button>
          <span className="viewer-variant"><strong>{variant.label}</strong> {variantPosition}/{variantTotal}</span>
          <button type="button" className="viewer-button" onClick={() => onVariant(1)} aria-label="Next variant">→</button>
        </div>
      </header>
      <div className="viewer-body">
        <div className="viewer-stage">
          <figure className="viewer-figure">
            <div className="viewer-image-wrap">
              <TerminalFrame frame={frame} label={`${screen.title}, ${variant.label}`} />
            </div>
            <figcaption className="viewer-caption">
              <h3>{screen.title}</h3>
              <div className="viewer-label-groups">
                <section>
                  <h4>Screens</h4>
                  <div className="viewer-facets">
                    {screen.screenLabels.map((value) => (
                      <button key={value} type="button" onClick={() => onTaxonomy("screen", value)}>
                        {taxonomyLabel(screenTaxonomy, value)}
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <h4>UI Elements</h4>
                  <div className="viewer-facets">
                    {screen.uiElements.map((value) => (
                      <button key={value} type="button" onClick={() => onTaxonomy("ui-element", value)}>
                        {taxonomyLabel(uiElementTaxonomy, value)}
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <h4>Labels</h4>
                  <div className="viewer-facets">
                    {facetOrder.flatMap((facet) =>
                      facetValues(screen, facet).map((value) => (
                        <button key={`${facet}:${value}`} type="button" onClick={() => onFacet({ facet, value })}>
                          {label(value)}
                        </button>
                      )),
                    )}
                  </div>
                </section>
              </div>
            </figcaption>
          </figure>
        </div>
      </div>
    </dialog>
  )
}
