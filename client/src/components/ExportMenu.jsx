import { useEffect, useRef, useState } from 'react'

/**
 * Small popover menu with export options. Closes on outside click / Escape.
 *
 * Props:
 *   items    — [{ key, label, onClick }] menu entries.
 *   label    — Button label (default "⬇ Export").
 *   title    — Button tooltip.
 *   size     — 'sm' | '' — button size class (default 'sm').
 *   align    — 'right' | 'left' — dropdown alignment (default 'right').
 */
export default function ExportMenu({
  items,
  label = '⬇ Export',
  title = 'Export this document',
  size  = 'sm',
  align = 'right',
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '8px 12px', background: 'transparent', border: 'none',
    color: 'inherit', font: 'inherit', cursor: 'pointer',
    whiteSpace: 'nowrap',
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={`btn btn-ghost${size ? ` btn-${size}` : ''}`}
        onClick={() => setOpen(o => !o)}
        title={title}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)',
            [align]: 0, zIndex: 20,
            minWidth: 210, padding: 4, borderRadius: 8,
            background: '#1f2937', border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.35)', fontSize: 13,
          }}
        >
          {items.map(it => (
            <button
              key={it.key}
              style={item}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.() }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
