import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Service worker registration + auto-update toast live inside <UpdatePrompt />
// (mounted in App.jsx) so installed PWA users get new deploys automatically.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
