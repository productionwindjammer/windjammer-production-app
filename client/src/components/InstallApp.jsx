import { useEffect, useState } from 'react'

/**
 * Install-as-app button.
 *  - Chrome/Edge/Android: captures beforeinstallprompt and shows native installer.
 *  - iOS Safari: shows manual "Add to Home Screen" instructions.
 *  - Already installed: renders nothing.
 */
export default function InstallApp({ className = '', label = '📲 Install App' }) {
  const [deferred, setDeferred] = useState(null)
  const [installed, setInstalled] = useState(false)
  const [showIos, setShowIos] = useState(false)

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    if (standalone) { setInstalled(true); return }

    const onPrompt = e => { e.preventDefault(); setDeferred(e) }
    const onInstalled = () => { setInstalled(true); setDeferred(null) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) return null

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream

  const handleClick = async () => {
    if (deferred) {
      deferred.prompt()
      const choice = await deferred.userChoice
      if (choice.outcome === 'accepted') setInstalled(true)
      setDeferred(null)
      return
    }
    if (isIos) { setShowIos(true); return }
    // Fallback: most desktop browsers expose install via address-bar menu
    setShowIos(true)
  }

  return (
    <>
      <button type="button" className={`install-app-btn ${className}`} onClick={handleClick}>
        {label}
      </button>

      {showIos && (
        <div className="install-modal-backdrop" onClick={() => setShowIos(false)}>
          <div className="install-modal" onClick={e => e.stopPropagation()}>
            <h3>Install Windjammer</h3>
            {isIos ? (
              <ol>
                <li>Tap the <strong>Share</strong> button <span aria-hidden>⬆️</span> in Safari's toolbar.</li>
                <li>Scroll and choose <strong>Add to Home Screen</strong>.</li>
                <li>Tap <strong>Add</strong> in the top-right corner.</li>
              </ol>
            ) : (
              <ol>
                <li>Open the browser menu (⋮ or ⋯ in the address bar).</li>
                <li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
                <li>Confirm to add Windjammer as a standalone app.</li>
              </ol>
            )}
            <p className="install-modal-hint">
              Once installed, Windjammer opens like a native app — no browser tabs.
            </p>
            <button type="button" className="install-app-btn" onClick={() => setShowIos(false)}>
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}
