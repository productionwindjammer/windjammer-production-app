import { useEffect, useState } from 'react'

/**
 * Registers /sw.js, polls for updates, and shows a small toast when a new
 * deploy is ready. Clicking the toast tells the waiting SW to take over,
 * then reloads — so end users always pick up the latest Railway build.
 */
export default function UpdatePrompt() {
  const [updateReady, setUpdateReady] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let reg
    const reloadOnControllerChange = () => window.location.reload()
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnControllerChange)

    const onMessage = e => {
      if (e.data && e.data.type === 'SW_UPDATED') setUpdateReady(true)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)

    const register = async () => {
      try {
        reg = await navigator.serviceWorker.register('/sw.js')

        // If a new SW is already waiting on first load, surface immediately
        if (reg.waiting) setUpdateReady(true)

        // Listen for future updates discovered in-session
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateReady(true)
            }
          })
        })

        // Poll for new deploys: on focus + every 5 minutes
        const check = () => reg && reg.update().catch(() => {})
        window.addEventListener('focus', check)
        const interval = setInterval(check, 5 * 60 * 1000)

        return () => {
          window.removeEventListener('focus', check)
          clearInterval(interval)
        }
      } catch (err) {
        console.warn('SW registration failed:', err)
      }
    }
    const cleanupPromise = register()

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', reloadOnControllerChange)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      Promise.resolve(cleanupPromise).then(fn => typeof fn === 'function' && fn())
    }
  }, [])

  if (!updateReady) return null

  const applyUpdate = async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
    else window.location.reload()
  }

  return (
    <div className="update-toast" role="status">
      <span>🔄 A new version of Windjammer is available.</span>
      <button type="button" onClick={applyUpdate}>Reload</button>
    </div>
  )
}
