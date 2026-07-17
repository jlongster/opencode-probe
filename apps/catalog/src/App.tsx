import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react"
import type {
  BrowseMode,
  Catalog,
  Facet,
  FacetSelections,
  Taxonomy,
} from "./catalog"
import { buildFacetIndex, emptyFacetSelections, filterFlows, filterScreens } from "./catalog"
import { CommandPalette } from "./components/CommandPalette"
import { ContactSheet } from "./components/ContactSheet"
import { FlowBrowser } from "./components/FlowBrowser"
import { Header } from "./components/Header"
import { SelectionBar } from "./components/SelectionBar"
import { Viewer } from "./components/Viewer"

interface AppProps {
  readonly catalog: Catalog
}

interface UiState {
  readonly mode: BrowseMode
  readonly query: string
  readonly screenLabels: ReadonlyArray<string>
  readonly uiElements: ReadonlyArray<string>
  readonly facets: FacetSelections
  readonly activeFlowId: string | undefined
  readonly selectedScreenId: string | undefined
  readonly viewerOpen: boolean
  readonly paletteOpen: boolean
  readonly gridFocusTick: number
}

type UiAction =
  | { readonly type: "set-mode"; readonly mode: BrowseMode }
  | { readonly type: "search"; readonly query: string }
  | { readonly type: "toggle-taxonomy"; readonly taxonomy: Taxonomy; readonly value: string }
  | { readonly type: "clear-taxonomy"; readonly taxonomy: Taxonomy }
  | { readonly type: "toggle-facet"; readonly facet: Facet; readonly value: string }
  | { readonly type: "clear-facets" }
  | { readonly type: "reset-view" }
  | { readonly type: "clear-search" }
  | { readonly type: "select-flow"; readonly id: string }
  | { readonly type: "select-screen"; readonly id: string }
  | { readonly type: "navigate"; readonly id: string }
  | { readonly type: "open-viewer"; readonly id: string }
  | { readonly type: "close-viewer" }
  | { readonly type: "jump-to-screen"; readonly id: string }
  | { readonly type: "jump-to-flow"; readonly id: string }
  | { readonly type: "open-palette" }
  | { readonly type: "close-palette" }
  | { readonly type: "toggle-palette" }

function toggle(values: ReadonlyArray<string>, value: string): ReadonlyArray<string> {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]
}

function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "set-mode":
      return {
        ...state,
        mode: action.mode,
        query: "",
        viewerOpen: false,
        selectedScreenId: undefined,
        gridFocusTick: state.gridFocusTick + 1,
      }
    case "search":
      return { ...state, query: action.query }
    case "toggle-taxonomy": {
      const key = action.taxonomy === "screen" ? "screenLabels" : "uiElements"
      return {
        ...state,
        mode: action.taxonomy === "screen" ? "screens" : "ui-elements",
        [key]: toggle(state[key], action.value),
        viewerOpen: false,
        paletteOpen: false,
        selectedScreenId: undefined,
        gridFocusTick: state.gridFocusTick + 1,
      }
    }
    case "clear-taxonomy": {
      const key = action.taxonomy === "screen" ? "screenLabels" : "uiElements"
      return { ...state, [key]: [], selectedScreenId: undefined, gridFocusTick: state.gridFocusTick + 1 }
    }
    case "toggle-facet":
      return {
        ...state,
        facets: { ...state.facets, [action.facet]: toggle(state.facets[action.facet], action.value) },
        viewerOpen: false,
        paletteOpen: false,
        selectedScreenId: undefined,
        gridFocusTick: state.gridFocusTick + 1,
      }
    case "clear-facets":
      return { ...state, facets: emptyFacetSelections, selectedScreenId: undefined, gridFocusTick: state.gridFocusTick + 1 }
    case "reset-view":
      return {
        ...state,
        query: "",
        screenLabels: state.mode === "screens" ? [] : state.screenLabels,
        uiElements: state.mode === "ui-elements" ? [] : state.uiElements,
        facets: emptyFacetSelections,
        selectedScreenId: undefined,
        gridFocusTick: state.gridFocusTick + 1,
      }
    case "clear-search":
      return { ...state, query: "", gridFocusTick: state.gridFocusTick + 1 }
    case "select-flow":
      return { ...state, activeFlowId: action.id }
    case "select-screen":
      return { ...state, selectedScreenId: action.id, gridFocusTick: state.gridFocusTick + 1 }
    case "navigate":
      return { ...state, selectedScreenId: action.id }
    case "open-viewer":
      return { ...state, selectedScreenId: action.id, viewerOpen: true }
    case "close-viewer":
      return { ...state, viewerOpen: false, gridFocusTick: state.gridFocusTick + 1 }
    case "jump-to-screen":
      return {
        ...state,
        mode: "screens",
        query: "",
        paletteOpen: false,
        selectedScreenId: action.id,
        viewerOpen: true,
      }
    case "jump-to-flow":
      return {
        ...state,
        mode: "flows",
        query: "",
        activeFlowId: action.id,
        selectedScreenId: undefined,
        viewerOpen: false,
        paletteOpen: false,
      }
    case "open-palette":
      return { ...state, paletteOpen: true }
    case "close-palette":
      return {
        ...state,
        paletteOpen: false,
        gridFocusTick: state.viewerOpen ? state.gridFocusTick : state.gridFocusTick + 1,
      }
    case "toggle-palette":
      return state.paletteOpen
        ? uiReducer(state, { type: "close-palette" })
        : { ...state, paletteOpen: true }
  }
}

export function App({ catalog }: AppProps) {
  const [ui, dispatch] = useReducer(uiReducer, {
    mode: "screens",
    query: "",
    screenLabels: [],
    uiElements: [],
    facets: emptyFacetSelections,
    activeFlowId: catalog.flows[0]?.id,
    selectedScreenId: catalog.screens[0]?.id,
    viewerOpen: false,
    paletteOpen: false,
    gridFocusTick: 0,
  })
  const [variantIndex, setVariantIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const activeVariant = catalog.variants[variantIndex] ?? catalog.variants[0]

  const facetIndex = useMemo(() => buildFacetIndex(catalog.screens), [catalog.screens])
  const screens = useMemo(
    () =>
      filterScreens(catalog.screens, ui.query, ui.mode, {
        screenLabels: ui.screenLabels,
        uiElements: ui.uiElements,
        facets: ui.facets,
      }),
    [catalog.screens, ui.query, ui.mode, ui.screenLabels, ui.uiElements, ui.facets],
  )
  const flows = useMemo(() => filterFlows(catalog.flows, ui.query), [catalog.flows, ui.query])
  const activeFlow = flows.find((flow) => flow.id === ui.activeFlowId) ?? flows[0]
  const viewerScreens =
    ui.mode === "flows" && activeFlow
      ? activeFlow.steps.flatMap((step) => {
          const screen = catalog.screens.find((candidate) => candidate.id === step.screenId)
          return screen ? [screen] : []
        })
      : screens
  const selectedId = viewerScreens.some((screen) => screen.id === ui.selectedScreenId)
    ? ui.selectedScreenId
    : viewerScreens[0]?.id
  const selectedScreen = catalog.screens.find((screen) => screen.id === selectedId)
  const taxonomy = ui.mode === "screens" ? catalog.screenTaxonomy : catalog.uiElementTaxonomy
  const taxonomyValues = ui.mode === "screens" ? ui.screenLabels : ui.uiElements
  const taxonomyCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const screen of catalog.screens) {
      const values = ui.mode === "screens" ? screen.screenLabels : screen.uiElements
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return counts
  }, [catalog.screens, ui.mode])

  const navigateViewer = (direction: 1 | -1) => {
    if (viewerScreens.length === 0) return
    const current = viewerScreens.findIndex((screen) => screen.id === selectedId)
    const next = viewerScreens[(current + direction + viewerScreens.length) % viewerScreens.length]
    if (next) dispatch({ type: "navigate", id: next.id })
  }

  const navigateVariant = (direction: 1 | -1) => {
    setVariantIndex((current) => (current + direction + catalog.variants.length) % catalog.variants.length)
  }

  const handleWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      dispatch({ type: "toggle-palette" })
      return
    }
    if (ui.paletteOpen || ui.viewerOpen) return
    const target = event.target
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    if (editing) return
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      navigateVariant(event.key === "ArrowLeft" ? -1 : 1)
      return
    }
    if (event.key === "/") {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    const hasFilters =
      taxonomyValues.length > 0 || Object.values(ui.facets).some((values) => values.length > 0)
    if (event.key === "Escape" && (ui.query !== "" || hasFilters)) {
      event.preventDefault()
      dispatch({ type: "reset-view" })
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleWindowKeyDown(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  const taxonomyType: Taxonomy = ui.mode === "ui-elements" ? "ui-element" : "screen"

  return (
    <>
      <main className="catalog-app">
        <Header
          catalog={catalog}
          mode={ui.mode}
          taxonomyValues={taxonomyValues}
          facets={ui.facets}
          query={ui.query}
          resultCount={ui.mode === "flows" ? flows.length : screens.length}
          taxonomyCounts={taxonomyCounts}
          searchRef={searchRef}
          variant={activeVariant}
          variantPosition={variantIndex + 1}
          onMode={(mode) => dispatch({ type: "set-mode", mode })}
          onQuery={(query) => dispatch({ type: "search", query })}
          onTaxonomy={(value) => dispatch({ type: "toggle-taxonomy", taxonomy: taxonomyType, value })}
          onClearTaxonomy={() => dispatch({ type: "clear-taxonomy", taxonomy: taxonomyType })}
          onFacet={(facet, value) => dispatch({ type: "toggle-facet", facet, value })}
          onClearFacets={() => dispatch({ type: "clear-facets" })}
          onClearSearch={() => dispatch({ type: "clear-search" })}
          onOpenPalette={() => dispatch({ type: "open-palette" })}
          onVariant={navigateVariant}
        />
        {ui.mode !== "flows" ? (
          <SelectionBar
            taxonomy={taxonomy}
            taxonomyValues={taxonomyValues}
            facets={ui.facets}
            onTaxonomy={(value) => dispatch({ type: "toggle-taxonomy", taxonomy: taxonomyType, value })}
            onFacet={(facet, value) => dispatch({ type: "toggle-facet", facet, value })}
            onClear={() => dispatch({ type: "reset-view" })}
          />
        ) : undefined}
        {ui.mode === "flows" ? (
          <FlowBrowser
            catalog={catalog}
            flows={flows}
            activeFlow={activeFlow}
            variantId={activeVariant.id}
            onFlow={(id) => dispatch({ type: "select-flow", id })}
            onOpen={(id) => dispatch({ type: "open-viewer", id })}
          />
        ) : (
          <ContactSheet
            screens={screens}
            selectedId={selectedId}
            focusTick={ui.gridFocusTick}
            keyboardEnabled={!ui.viewerOpen && !ui.paletteOpen}
            variantId={activeVariant.id}
            onSelect={(id) => dispatch({ type: "select-screen", id })}
            onOpen={(id) => dispatch({ type: "open-viewer", id })}
          />
        )}
      </main>
      {ui.viewerOpen && selectedScreen ? (
        <Viewer
          key={selectedScreen.id}
          screen={selectedScreen}
          identifier={ui.mode === "flows" && activeFlow ? `${activeFlow.id}/${selectedScreen.id}` : selectedScreen.id}
          variant={activeVariant}
          variantPosition={variantIndex + 1}
          variantTotal={catalog.variants.length}
          screenTaxonomy={catalog.screenTaxonomy}
          uiElementTaxonomy={catalog.uiElementTaxonomy}
          position={viewerScreens.findIndex((screen) => screen.id === selectedScreen.id) + 1}
          total={viewerScreens.length}
          active={!ui.paletteOpen}
          onClose={() => dispatch({ type: "close-viewer" })}
          onNavigate={navigateViewer}
          onVariant={navigateVariant}
          onFacet={(filter) => dispatch({ type: "toggle-facet", ...filter })}
          onTaxonomy={(taxonomy, value) => dispatch({ type: "toggle-taxonomy", taxonomy, value })}
        />
      ) : undefined}
      {ui.paletteOpen ? (
        <CommandPalette
          catalog={catalog}
          facetIndex={facetIndex}
          onClose={() => dispatch({ type: "close-palette" })}
          onFacet={(filter) => dispatch({ type: "toggle-facet", ...filter })}
          onTaxonomy={(taxonomy, value) => dispatch({ type: "toggle-taxonomy", taxonomy, value })}
          onScreen={(id) => dispatch({ type: "jump-to-screen", id })}
          onFlow={(id) => dispatch({ type: "jump-to-flow", id })}
        />
      ) : undefined}
    </>
  )
}
