import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useSplit } from '../context/SplitContext'
import { navForRole } from '../nav'
import { useAuth } from '../context/AuthContext'

// Renders the right-hand pane of the split view: a toolbar (route picker,
// pop-out, close) above a same-origin iframe of the chosen route. Auth is
// shared via localStorage so the iframe just works.
export default function SplitPane() {
  const { rightPath, setRightPath, setEnabled, popout, ratio, setRatio } = useSplit()
  const { effectiveRole } = useAuth()
  const location = useLocation()
  const iframeRef = useRef(null)
  const dragRef = useRef(null)

  const items = navForRole(effectiveRole).filter(i => i.path !== location.pathname)

  // Resizable divider: track pointer to update ratio against the .split-host width.
  useEffect(() => {
    const handle = dragRef.current
    if (!handle) return
    let dragging = false
    const onDown = (e) => { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none' }
    const onMove = (e) => {
      if (!dragging) return
      const host = handle.parentElement
      if (!host) return
      const rect = host.getBoundingClientRect()
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
      setRatio(x / rect.width)
    }
    const onUp = () => { dragging = false; document.body.style.userSelect = '' }
    handle.addEventListener('mousedown', onDown)
    handle.addEventListener('touchstart', onDown, { passive: false })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    return () => {
      handle.removeEventListener('mousedown', onDown)
      handle.removeEventListener('touchstart', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
    }
  }, [setRatio])

  return (
    <>
      <div className="split-divider" ref={dragRef} title="Drag to resize" />
      <aside className="split-pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <div className="split-toolbar">
          <select value={rightPath} onChange={e => setRightPath(e.target.value)}>
            {items.map(i => (
              <option key={i.path} value={i.path}>{i.icon} {i.label}</option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Open this pane in a new window"
            onClick={() => popout(rightPath)}
          >↗ Pop out</button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Close split"
            onClick={() => setEnabled(false)}
          >✕</button>
        </div>
        <iframe
          ref={iframeRef}
          className="split-frame"
          title="Split pane"
          src={rightPath}
        />
      </aside>
    </>
  )
}
