export default function Modal({ isOpen, title, onClose, footer, size = '', children }) {
  // Callers that conditionally render Modal skip the prop; treat undefined
  // as "shown". Only an explicit falsy isOpen hides the overlay.
  if (isOpen === false) return null
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
