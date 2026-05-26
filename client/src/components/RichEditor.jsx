import { useRef, useState, useEffect } from 'react'
import api from '../api'

export default function RichEditor({ initialHTML = '', onChange }) {
  const editorRef   = useRef(null)
  const fileInputRef = useRef(null)
  const savedRange   = useRef(null)
  const [imgModal, setImgModal]   = useState(false)
  const [imgUrl, setImgUrl]       = useState('')
  const [uploading, setUploading] = useState(false)

  // Initialize on mount only — parent uses `key` prop to remount on doc switch
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = initialHTML
      editorRef.current.focus()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function fireChange() {
    onChange?.(editorRef.current?.innerHTML || '')
  }

  function exec(cmd, arg = null) {
    editorRef.current?.focus()
    document.execCommand(cmd, false, arg)
    fireChange()
  }

  function saveSelection() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange()
  }

  function restoreSelection() {
    if (!savedRange.current) return
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
  }

  function openImgModal(e) {
    e.preventDefault()
    saveSelection()
    setImgUrl('')
    setImgModal(true)
  }

  function insertImage(url) {
    if (!url) return
    restoreSelection()
    editorRef.current?.focus()
    document.execCommand('insertImage', false, url)
    // Style inserted image
    const imgs = editorRef.current?.querySelectorAll('img:not([data-styled])')
    imgs?.forEach(img => {
      img.style.maxWidth = '100%'
      img.style.borderRadius = '6px'
      img.dataset.styled = '1'
    })
    fireChange()
    setImgModal(false)
  }

  function insertTable(e) {
    e.preventDefault()
    saveSelection()
    restoreSelection()
    editorRef.current?.focus()
    const html = `
      <table style="border-collapse:collapse;width:100%;margin:12px 0">
        <tbody>
          <tr>
            <th style="border:1px solid #444;padding:7px 12px;background:rgba(255,255,255,0.07);text-align:left">Column 1</th>
            <th style="border:1px solid #444;padding:7px 12px;background:rgba(255,255,255,0.07);text-align:left">Column 2</th>
            <th style="border:1px solid #444;padding:7px 12px;background:rgba(255,255,255,0.07);text-align:left">Column 3</th>
          </tr>
          <tr>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
          </tr>
          <tr>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
            <td style="border:1px solid #444;padding:7px 12px">&nbsp;</td>
          </tr>
        </tbody>
      </table><p><br></p>`
    document.execCommand('insertHTML', false, html)
    fireChange()
  }

  async function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = async () => {
        try {
          const base64 = reader.result.split(',')[1]
          const res = await api.post('/upload', { filename: file.name, mimeType: file.type, data: base64 })
          if (res.data.success) insertImage(res.data.url)
        } catch (err) {
          alert('Image upload failed: ' + (err.response?.data?.message || err.message))
        } finally {
          setUploading(false)
          setImgModal(false)
          if (fileInputRef.current) fileInputRef.current.value = ''
        }
      }
    } catch {
      setUploading(false)
    }
  }

  const tb = (cmd, arg, label, title) => (
    <button
      className="re-btn"
      title={title || label}
      onMouseDown={e => { e.preventDefault(); exec(cmd, arg) }}
    >{label}</button>
  )

  return (
    <div className="rich-editor">
      {/* Toolbar */}
      <div className="rich-toolbar">
        {tb('bold',          null, <b>B</b>,   'Bold')}
        {tb('italic',        null, <i>I</i>,   'Italic')}
        {tb('underline',     null, <u>U</u>,   'Underline')}
        <span className="re-sep" />
        {tb('formatBlock', 'h1', 'H1', 'Heading 1')}
        {tb('formatBlock', 'h2', 'H2', 'Heading 2')}
        {tb('formatBlock', 'h3', 'H3', 'Heading 3')}
        {tb('formatBlock', 'p',  '¶',  'Paragraph')}
        <span className="re-sep" />
        {tb('insertUnorderedList', null, '• ≡', 'Bullet List')}
        {tb('insertOrderedList',   null, '1 ≡', 'Numbered List')}
        <span className="re-sep" />
        <button className="re-btn" title="Insert Image" onMouseDown={openImgModal}>🖼</button>
        <button className="re-btn" title="Insert Table"  onMouseDown={insertTable}>⊞</button>
        {tb('insertHorizontalRule', null, '─', 'Horizontal Rule')}
        <span className="re-sep" />
        {tb('removeFormat', null, <span style={{color:'#f87171'}}>✕</span>, 'Clear Formatting')}
      </div>

      {/* Editable area */}
      <div
        ref={editorRef}
        className="rich-content"
        contentEditable
        suppressContentEditableWarning
        onInput={fireChange}
        spellCheck
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* Image modal */}
      {imgModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setImgModal(false)}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3>Insert Image</h3>
              <button className="modal-close" onClick={() => setImgModal(false)}>×</button>
            </div>
            <div className="modal-body form-grid">
              <button
                className="btn btn-primary w-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading to Drive…' : '📁 Upload from Computer'}
              </button>
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '4px 0' }}>— or paste a URL —</div>
              <div className="form-group">
                <label>Image URL</label>
                <input
                  autoFocus
                  value={imgUrl}
                  onChange={e => setImgUrl(e.target.value)}
                  placeholder="https://…"
                  onKeyDown={e => e.key === 'Enter' && imgUrl && insertImage(imgUrl)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setImgModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => insertImage(imgUrl)} disabled={!imgUrl}>Insert URL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
