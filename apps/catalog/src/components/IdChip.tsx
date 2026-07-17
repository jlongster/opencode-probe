import { useEffect, useRef, useState } from "react"

interface IdChipProps {
  readonly id: string
  readonly className?: string
}

export function IdChip({ id, className = "" }: IdChipProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className={`id-chip ${className}`.trim()}
      data-copied={copied ? "" : undefined}
      title={`Copy ${id}`}
      aria-label={`Copy identifier ${id}`}
      onClick={copy}
    >
      <svg className="id-chip-glyph" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 3.5v-2h6v6h-2" fill="none" stroke="currentColor" />
        <rect x="1.5" y="4.5" width="6" height="6" fill="none" stroke="currentColor" />
      </svg>
      <span className="id-chip-text">
        <span className="id-chip-value">{id}</span>
        <span className="id-chip-copied" aria-hidden="true">
          copied
        </span>
      </span>
    </button>
  )
}
