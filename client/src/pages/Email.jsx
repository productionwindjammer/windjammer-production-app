import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../api'
import GmailConnect from '../components/GmailConnect'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'

export default function Email() {
  const { effectiveRole } = useAuth()
  const canRelink = ['admin', 'production_manager'].includes(effectiveRole)
  const [searchParams] = useSearchParams()
  const [advances, setAdvances]         = useState([])
  const [shows, setShows]               = useState([])
  const [emails, setEmails]             = useState([])
  const [selected, setSelected]         = useState(null)   // advance record
  const [expandedId, setExpandedId]     = useState(null)   // email.id
  const [emailDetail, setEmailDetail]   = useState(null)   // {htmlBody, textBody, attachments}
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [composeOpen, setComposeOpen]   = useState(false)
  const [replyData, setReplyData]       = useState(null)   // {threadId, gmailMessageId}
  const [form, setForm]                 = useState({ to: '', cc: '', subject: '', body: '', attachments: [] })
  const [syncing, setSyncing]           = useState(false)
  const [sending, setSending]           = useState(false)
  const [savingToDrive, setSavingToDrive] = useState(new Set())
  const [facilityDocs, setFacilityDocs]   = useState(null)
  const [loadingFacDocs, setLoadingFacDocs] = useState(false)
  const [loading, setLoading]           = useState(true)
  const [loadingEmails, setLoadingEmails] = useState(false)
  const fileInputRef = useRef(null)

  // ── Inbox state ─────────────────────────────────────────────────────────────
  const [viewMode, setViewMode]         = useState('show') // 'show' | 'inbox' | 'mine'
  const [inboxEmails, setInboxEmails]   = useState([])
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [syncingInbox, setSyncingInbox] = useState(false)
  const [syncingMine, setSyncingMine]   = useState(false)
  const [gmailStatus, setGmailStatus]   = useState(null) // { configured, connected, gmailEmail, isHouseMailbox }
  const [assigningId, setAssigningId]   = useState(null) // email.id whose picker is open
  const [assignSubmitting, setAssignSubmitting] = useState(false)

  // Multi-select state for bulk-linking many emails to a single show
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkShowId, setBulkShowId]   = useState('')
  const [bulkShowPast, setBulkShowPast] = useState(false)
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [allShowsPickerOpen, setAllShowsPickerOpen] = useState(false)
  const [sidebarShowPast, setSidebarShowPast] = useState(false)

  // 🤖 Bot suggest-links modal state
  const [suggestOpen, setSuggestOpen]         = useState(false)
  const [suggestLoading, setSuggestLoading]   = useState(false)
  const [suggestRows, setSuggestRows]         = useState([])    // [{emailId, subject, from, date, snippet, suggestion}]
  const [suggestPicked, setSuggestPicked]     = useState(() => new Set()) // emailIds accepted
  const [suggestApplying, setSuggestApplying] = useState(false)
  const [suggestMinConf, setSuggestMinConf]   = useState('medium')
  const [suggestFetchBody, setSuggestFetchBody] = useState(false)
  const [suggestMeta, setSuggestMeta]         = useState(null)  // { total, suggestionCount, bodyEnriched }

  function toggleSelected(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function clearSelection() { setSelectedIds(new Set()); setBulkShowId('') }
  function selectAllVisible(rows) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const r of rows) next.add(r.id)
      return next
    })
  }

  async function handleBulkLink() {
    if (!bulkShowId || selectedIds.size === 0) return
    setBulkSubmitting(true)
    try {
      const ids = [...selectedIds]
      const res = await api.post('/emails/assign-bulk', { ids, showId: bulkShowId })
      const { showName, linked } = res.data
      // Patch both lists so the show-name chip appears immediately
      const idSet = new Set(ids)
      setInboxEmails(list => list.map(e => idSet.has(e.id) ? { ...e, showId: bulkShowId, showName } : e))
      setEmails(list => list.map(e => idSet.has(e.id) ? { ...e, showId: bulkShowId, showName } : e))
      clearSelection()
      alert(`Linked ${linked} email${linked !== 1 ? 's' : ''} to "${showName}".`)
    } catch (err) {
      alert('Bulk link failed: ' + (err.response?.data?.message || err.message))
    } finally {
      setBulkSubmitting(false)
    }
  }

  // Load the current user's private emails into the inbox view
  async function loadMine() {
    setLoadingInbox(true)
    try {
      const [meRes, listRes] = await Promise.all([
        api.get('/auth/me'),
        api.get('/emails'),
      ])
      const myId = meRes.data.user?.id
      const rows = (listRes.data.data || []).filter(e => e.sourceUserId === myId)
      rows.sort((a, b) => new Date(b.date) - new Date(a.date))
      setInboxEmails(rows)
    } finally {
      setLoadingInbox(false)
    }
  }

  function switchToMine() {
    setSelected(null)
    setExpandedId(null)
    setEmailDetail(null)
    setViewMode('mine')
    loadMine()
  }

  async function handleSyncMine() {
    setSyncingMine(true)
    try {
      await api.post('/emails/sync-mine')
      await loadMine()
    } catch (err) {
      alert('Sync failed: ' + (err.response?.data?.message || err.message))
    } finally {
      setSyncingMine(false)
    }
  }

  // Assign an inbox email to a show; optionally set the sender as that show's advance contact
  async function handleAssignEmailToShow(email, showId, setAdvanceEmail) {
    setAssignSubmitting(true)
    try {
      const res = await api.post(`/emails/${email.id}/assign`, { showId, setAdvanceEmail })
      const { showName, advanceEmailSet } = res.data
      // Update the row in whichever lists it appears in
      setInboxEmails(list => list.map(e => e.id === email.id ? { ...e, showId, showName } : e))
      setEmails(list => list.map(e => e.id === email.id ? { ...e, showId, showName } : e))
      setAssigningId(null)
      if (advanceEmailSet) {
        // Refresh advances so the sidebar shows the new contact
        const a = await api.get('/advancing')
        setAdvances(a.data.data || [])
        alert(`Linked to "${showName}" and set ${advanceEmailSet} as the advance contact.`)
      } else {
        alert(`Linked to "${showName}".`)
      }
    } catch (err) {
      alert('Could not link email: ' + (err.response?.data?.message || err.message))
    } finally {
      setAssignSubmitting(false)
    }
  }
  // ── Load advances + shows on mount ─────────────────────────────────────────
  useEffect(() => {
    Promise.all([api.get('/advancing'), api.get('/shows')]).then(([a, s]) => {
      const adv = a.data.data || []
      const sh  = s.data.data || []
      setAdvances(adv)
      setShows(sh)

      // Auto-select if showId is in URL
      const urlShowId = searchParams.get('showId')
      if (urlShowId) {
        const match = adv.find(x => x.showId === urlShowId)
        if (match) setSelected(match)
      }
    }).finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load emails when selection changes ──────────────────────────────────────
  useEffect(() => {
    if (!selected) { setEmails([]); return }
    setLoadingEmails(true)
    setExpandedId(null)
    setEmailDetail(null)
    api.get(`/emails?showId=${selected.showId}`)
      .then(res => {
        const sorted = (res.data.data || []).sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        )
        setEmails(sorted)
      })
      .finally(() => setLoadingEmails(false))
  }, [selected])

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function getShowName(adv) {
    if (adv.showName) return adv.showName
    const s = shows.find(s => s.id === adv.showId)
    return s ? `${s.date} — ${s.artist || s.eventName}` : adv.showId
  }

  function formatDate(dateStr) {
    try {
      return new Date(dateStr).toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    } catch { return dateStr }
  }

  function getAttachments(email) {
    try { return JSON.parse(email.attachmentMeta || '[]') } catch { return [] }
  }

  // ── Expand email and fetch full body ────────────────────────────────────────
  async function handleSelectEmail(email) {
    if (expandedId === email.id) {
      setExpandedId(null)
      setEmailDetail(null)
      return
    }
    setExpandedId(email.id)
    setEmailDetail(null)
    setLoadingDetail(true)
    try {
      const res = await api.get(`/emails/message/${email.gmailMessageId}`)
      setEmailDetail(res.data)
    } catch {
      setEmailDetail({ htmlBody: '', textBody: email.snippet, attachments: [] })
    } finally {
      setLoadingDetail(false)
    }
  }

  // ── Sync Gmail for selected show ────────────────────────────────────────────
  async function handleSync() {
    if (!selected) return
    setSyncing(true)
    try {
      await api.post('/emails/sync', {
        showId:       selected.showId,
        advanceEmail: selected.advanceEmail,
        showName:     getShowName(selected),
      })
      const res = await api.get(`/emails?showId=${selected.showId}`)
      setEmails(
        (res.data.data || []).sort((a, b) => new Date(a.date) - new Date(b.date))
      )
    } finally {
      setSyncing(false)
    }
  }

  // ── Full inbox view ─────────────────────────────────────────────────────────
  async function loadInbox() {
    setLoadingInbox(true)
    try {
      const res = await api.get('/emails') // no showId = all emails
      setInboxEmails((res.data.data || []).sort((a, b) => new Date(b.date) - new Date(a.date)))
    } finally { setLoadingInbox(false) }
  }

  async function handleSyncInbox() {
    setSyncingInbox(true)
    try {
      await api.post('/emails/sync-inbox')
      await loadInbox()
    } catch (err) {
      alert('Inbox sync failed: ' + (err.response?.data?.message || err.message))
    } finally { setSyncingInbox(false) }
  }

  // ── Re-link all stored emails to shows (admin/PM only) ─────────────────────
  const [relinking, setRelinking] = useState(false)
  async function handleRelinkAll() {
    const ok = confirm(
      'Unlink every stored email and re-match against current shows?\n\n' +
      'The bot will look at each email\'s subject, snippet, date and sender/recipient ' +
      'and try to match by:\n' +
      '  • known advance contact email (highest confidence)\n' +
      '  • artist name (incl. registry aliases)\n' +
      '  • show date appearing in the subject/snippet\n' +
      '  • email sent close to the show date\n\n' +
      'Emails with no confident match will be left unlinked.'
    )
    if (!ok) return
    setRelinking(true)
    try {
      const res = await api.post('/emails/relink-all', { mode: 'reset' })
      const { processed = 0, linked = 0, cleared = 0, unchanged = 0 } = res.data || {}
      alert(`Done.\n\nProcessed: ${processed}\nNewly linked: ${linked}\nCleared: ${cleared}\nUnchanged: ${unchanged}`)
      if (viewMode === 'inbox')      await loadInbox()
      else if (viewMode === 'mine')  await loadMine()
      else if (selected) {
        const r = await api.get(`/emails?showId=${selected.showId}`)
        setEmails((r.data.data || []).sort((a, b) => new Date(a.date) - new Date(b.date)))
      }
    } catch (err) {
      alert('Re-link failed: ' + (err.response?.data?.message || err.message))
    } finally { setRelinking(false) }
  }

  // ── Bot: suggest links for currently-unlinked emails ──────────────────────
  async function openSuggestModal() {
    setSuggestOpen(true)
    setSuggestPicked(new Set())
    setSuggestRows([])
    setSuggestMeta(null)
    await loadSuggestions(suggestMinConf, suggestFetchBody)
  }
  async function loadSuggestions(minConf, fetchBody) {
    setSuggestLoading(true)
    try {
      const params = new URLSearchParams({ minConfidence: minConf })
      if (fetchBody) params.set('fetchBody', '1')
      const res = await api.get(`/emails/suggest-links?${params}`)
      const rows = res.data.suggestions || []
      setSuggestRows(rows)
      setSuggestMeta({
        total: res.data.total,
        suggestionCount: res.data.suggestionCount,
        bodyEnriched: res.data.bodyEnriched,
      })
      // Pre-pick all "high" confidence matches
      setSuggestPicked(new Set(rows.filter(r => r.suggestion.confidence === 'high').map(r => r.emailId)))
    } catch (err) {
      alert('Bot suggest failed: ' + (err.response?.data?.message || err.message))
    } finally { setSuggestLoading(false) }
  }
  function toggleSuggestPicked(id) {
    setSuggestPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function pickAllSuggested(filter) {
    setSuggestPicked(new Set(
      suggestRows.filter(r => !filter || filter(r)).map(r => r.emailId)
    ))
  }
  async function applySuggestions() {
    if (suggestPicked.size === 0) return
    setSuggestApplying(true)
    try {
      // Group accepted rows by (showId, artistId) so we can use the bulk endpoint.
      // Artist-only suggestions (no showId) get linked to the artist record only.
      const groups = new Map() // key -> { showId, artistId, ids }
      for (const r of suggestRows) {
        if (!suggestPicked.has(r.emailId)) continue
        const sid = r.suggestion.showId   || ''
        const aid = r.suggestion.artistId || ''
        if (!sid && !aid) continue
        const key = `${sid}|${aid}`
        if (!groups.has(key)) groups.set(key, { showId: sid, artistId: aid, ids: [] })
        groups.get(key).ids.push(r.emailId)
      }
      let linkedTotal = 0
      const linkedNames = []
      for (const { showId, artistId, ids } of groups.values()) {
        const body = { ids }
        if (showId)   body.showId   = showId
        if (artistId) body.artistId = artistId
        const res = await api.post('/emails/assign-bulk', body)
        linkedTotal += res.data.linked || 0
        const label = res.data.showName || (res.data.artistName ? `${res.data.artistName} (artist)` : '')
        if (label) linkedNames.push(`${res.data.linked}× ${label}`)
        // Patch in-memory lists
        const idSet = new Set(ids)
        const patch = {
          showId:     res.data.showId     || '',
          showName:   res.data.showName   || '',
          artistId:   res.data.artistId   || '',
          artistName: res.data.artistName || '',
        }
        setInboxEmails(list => list.map(e => idSet.has(e.id) ? { ...e, ...patch } : e))
        setEmails(list => list.map(e => idSet.has(e.id) ? { ...e, ...patch } : e))
      }
      setSuggestOpen(false)
      alert(`Linked ${linkedTotal} email${linkedTotal !== 1 ? 's' : ''}.\n\n` + linkedNames.join('\n'))
    } catch (err) {
      alert('Apply failed: ' + (err.response?.data?.message || err.message))
    } finally { setSuggestApplying(false) }
  }

  function switchToInbox() {
    setViewMode('inbox')
    loadInbox()
  }

  function switchToShow(adv) {
    setViewMode('show')
    setSelected(adv)
  }

  // ── Open compose (new or reply) ─────────────────────────────────────────────
  function openCompose() {
    setReplyData(null)
    setForm({
      to:          selected?.advanceEmail || '',
      cc:          '',
      subject:     `Advancing: ${getShowName(selected)}`,
      body:        '',
      attachments: [],
    })
    setComposeOpen(true)
  }

  function openReply(email) {
    const replyTo = email.direction === 'outbound' ? email.to : email.from
    setReplyData({ threadId: email.gmailThreadId, gmailMessageId: email.gmailMessageId })
    setForm({
      to:          replyTo,
      cc:          '',
      subject:     email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body:        '',
      attachments: [],
    })
    setComposeOpen(true)
  }

  // ── Attach files to compose ─────────────────────────────────────────────────
  async function handleAttachFiles(e) {
    const files = Array.from(e.target.files)
    const attachments = await Promise.all(
      files.map(f => new Promise(resolve => {
        const reader = new FileReader()
        reader.onload = evt => resolve({
          filename: f.name,
          mimeType: f.type || 'application/octet-stream',
          data:     evt.target.result.split(',')[1], // base64 only
        })
        reader.readAsDataURL(f)
      }))
    )
    setForm(v => ({ ...v, attachments: [...v.attachments, ...attachments] }))
    // Reset file input so the same file can be added again if needed
    e.target.value = ''
  }

  // ── Send email ──────────────────────────────────────────────────────────────
  async function handleSend() {
    if (!form.to || !form.subject || !form.body) return
    setSending(true)
    try {
      await api.post('/emails/send', {
        showId:         selected?.showId || '',
        showName:       selected ? getShowName(selected) : '',
        to:             form.to,
        cc:             form.cc,
        subject:        form.subject,
        body:           form.body.replace(/\n/g, '<br>'),
        attachments:    form.attachments,
        inReplyToMsgId: replyData?.gmailMessageId || null,
        threadId:       replyData?.threadId || null,
      })
      setComposeOpen(false)
      // Reload thread
      const res = await api.get(`/emails?showId=${selected?.showId}`)
      setEmails(
        (res.data.data || []).sort((a, b) => new Date(a.date) - new Date(b.date))
      )
    } finally {
      setSending(false)
    }
  }

  // ── Save attachment to Google Drive ─────────────────────────────────────────
  async function handleSaveToDrive(email, att) {
    const key = `${email.gmailMessageId}-${att.attachmentId}`
    setSavingToDrive(prev => new Set([...prev, key]))
    try {
      await api.post('/emails/save-to-drive', {
        messageId:    email.gmailMessageId,
        attachmentId: att.attachmentId,
        filename:     att.filename,
        mimeType:     att.mimeType || 'application/octet-stream',
        showId:       selected?.showId,
      })
      alert(`✅ "${att.filename}" saved to show Drive folder.`)
    } catch (err) {
      alert('Could not save to Drive. ' + (err.response?.data?.error || err.message))
    } finally {
      setSavingToDrive(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  // ── Facility doc quick-attach ────────────────────────────────────────────────
  async function loadFacilityDocs() {
    if (facilityDocs !== null) return facilityDocs
    setLoadingFacDocs(true)
    try {
      const res = await api.get('/techpack')
      const docs = res.data.data || []
      setFacilityDocs(docs)
      return docs
    } finally {
      setLoadingFacDocs(false)
    }
  }

  async function handleAttachFacilityDoc(docType, label) {
    const docs = facilityDocs !== null ? facilityDocs : await loadFacilityDocs()
    const stage = selected?.stage || 'inside'
    const doc = docs.find(d => d.stage === stage && d.docType === docType)
    if (!doc || !doc.content) {
      alert(`No content found for "${label}". Please add it in the Tech Pack section first.`)
      return
    }
    const b64 = btoa(unescape(encodeURIComponent(doc.content)))
    const stageName = stage === 'inside' ? 'Inside Stage' : 'Beach Stage'
    const filename = `${stageName} — ${label}.html`
    setForm(v => ({
      ...v,
      attachments: [...v.attachments, { filename, mimeType: 'text/html', data: b64 }],
    }))
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Loading…</div>

  const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime() })()
  const visibleAdvances = sidebarShowPast ? advances : advances.filter(adv => {
    const s = shows.find(x => x.id === adv.showId)
    if (!s?.date) return true
    const d = new Date(s.date + 'T12:00:00').getTime()
    return d >= todayMs
  })

  return (
    <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 80px)', overflow: 'hidden' }}>

      {/* ── Left panel: show list ────────────────────────────────────────── */}
      <div style={{
        width: 280, minWidth: 220, borderRight: '1px solid rgba(255,255,255,0.08)',
        overflowY: 'auto', flexShrink: 0,
      }}>
        <div style={{
          padding: '12px 16px 6px',
          fontWeight: 700, fontSize: 11, color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Advancing Shows
        </div>

        {/* Inbox toggle */}
        <div
          onClick={switchToMine}
          style={{
            padding: '10px 16px',
            cursor: 'pointer',
            borderLeft: viewMode === 'mine' ? '3px solid #10b981' : '3px solid transparent',
            background: viewMode === 'mine' ? 'rgba(16,185,129,0.12)' : 'transparent',
            display: 'flex', alignItems: 'center', gap: 8,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 16 }}>📨</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>My Inbox</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>From your connected Gmail</div>
          </div>
        </div>

        <div
          onClick={switchToInbox}
          style={{
            padding: '10px 16px',
            cursor: 'pointer',
            borderLeft: viewMode === 'inbox' ? '3px solid #a78bfa' : '3px solid transparent',
            background: viewMode === 'inbox' ? 'rgba(167,139,250,0.12)' : 'transparent',
            display: 'flex', alignItems: 'center', gap: 8,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 16 }}>📬</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Full Gmail Inbox</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>All emails, all shows</div>
          </div>
        </div>

        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '4px 0' }} />

        <label style={{
          display:'flex', alignItems:'center', gap:6, padding:'6px 16px',
          fontSize:11, color:'rgba(255,255,255,0.5)', cursor:'pointer',
        }}>
          <input type="checkbox" checked={sidebarShowPast} onChange={e => setSidebarShowPast(e.target.checked)} />
          Show past shows
        </label>

        {visibleAdvances.length === 0 && (
          <div className="empty-state" style={{ margin: 16 }}>No advance records yet</div>
        )}

        {visibleAdvances.map(adv => {
          const isSelected = viewMode === 'show' && selected?.id === adv.id
          const emailCount = emails.length // only accurate when this show is selected
          return (
            <div
              key={adv.id}
              onClick={() => switchToShow(adv)}
              style={{
                padding: '10px 16px',
                cursor: 'pointer',
                borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                background: isSelected ? 'rgba(59,130,246,0.12)' : 'transparent',
                transition: 'background 0.15s',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>
                {getShowName(adv)}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                {adv.advanceEmail || <em>No contact email</em>}
              </div>
              <div style={{ marginTop: 5, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span
                  className={`badge badge-${adv.advancingComplete === 'true' ? 'confirmed' : 'pending'}`}
                  style={{ fontSize: 10 }}
                >
                  {adv.advancingComplete === 'true' ? 'Complete' : 'Open'}
                </span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                  {adv.stage === 'inside' ? 'Inside' : 'Beach'}
                </span>
                {isSelected && emailCount > 0 && (
                  <span style={{ fontSize: 10, color: '#93c5fd', marginLeft: 'auto' }}>
                    {emailCount} email{emailCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Right panel: thread view ─────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {viewMode === 'mine' ? (
          /* ── My Inbox view (per-user Gmail) ───────────────────────── */
          <>
            <div style={{
              padding: '14px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>📨 My Inbox</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 3 }}>
                  Windjammer-relevant emails from your personal Gmail. Private to you {gmailStatus?.isHouseMailbox ? '— currently marked as house mailbox (visible to all)' : ''}.
                </div>
              </div>
              {gmailStatus?.connected && (
                <button className="btn btn-ghost btn-sm" onClick={handleSyncMine} disabled={syncingMine}>
                  {syncingMine ? '⟳ Syncing…' : '⟳ Sync My Gmail'}
                </button>
              )}
              {canRelink && (
                <button className="btn btn-ghost btn-sm" onClick={openSuggestModal}
                  title="Have the bot look at every unlinked email and suggest a show based on subject, sender, date and body context">
                  🤖 Suggest links
                </button>
              )}
              {canRelink && (
                <button className="btn btn-ghost btn-sm" onClick={handleRelinkAll} disabled={relinking}
                  title="Unlink every email and re-match against current shows by date + artist name">
                  {relinking ? '🔗 Re-linking…' : '🔗 Re-link all'}
                </button>
              )}
            </div>
            <div style={{ padding: 16 }}>
              <GmailConnect onChange={setGmailStatus} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {selectedIds.size > 0 && (
                <BulkLinkBar
                  count={selectedIds.size}
                  shows={shows}
                  showId={bulkShowId} setShowId={setBulkShowId}
                  showPast={bulkShowPast} setShowPast={setBulkShowPast}
                  submitting={bulkSubmitting}
                  onLink={handleBulkLink}
                  onClear={clearSelection}
                  onSelectAll={() => selectAllVisible(inboxEmails)}
                  onOpenAllShows={() => setAllShowsPickerOpen(true)}
                />
              )}
              {!gmailStatus?.connected ? (
                <div className="empty-state" style={{ marginTop: 16 }}>
                  Connect your Gmail above to start pulling your own messages.
                </div>
              ) : loadingInbox ? (
                <div className="loading">Loading…</div>
              ) : inboxEmails.length === 0 ? (
                <div className="empty-state" style={{ marginTop: 16 }}>
                  No messages yet. Click <strong>⟳ Sync My Gmail</strong>.
                </div>
              ) : (
                inboxEmails.map(email => (
                  <div key={email.id} style={{
                    margin: '5px 12px', borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.08)',
                    padding: '10px 14px',
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    background: selectedIds.has(email.id) ? 'rgba(59,130,246,0.10)' : undefined,
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(email.id)}
                      onChange={() => toggleSelected(email.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ width: 13, height: 13, margin: '3px 0 0', flexShrink: 0, cursor: 'pointer', accentColor: '#3b82f6' }}
                      title="Select for bulk link"
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        {email.direction === 'outbound' ? `To: ${email.to}` : email.from}
                      </span>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{formatDate(email.date)}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{email.subject}</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {email.snippet}
                    </div>
                    {email.showName && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(59,130,246,0.2)', color: '#93c5fd', marginTop: 4, display: 'inline-block' }}>
                        {email.showName}
                      </span>
                    )}
                    {email.artistName && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(16,185,129,0.2)', color: '#6ee7b7', marginTop: 4, marginLeft: 4, display: 'inline-block' }} title="Linked to artist record">
                        🎤 {email.artistName}
                      </span>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <EmailAssignControl
                        email={email}
                        advances={advances}
                        shows={shows}
                        open={assigningId === email.id}
                        onToggle={() => setAssigningId(assigningId === email.id ? null : email.id)}
                        onAssign={handleAssignEmailToShow}
                        submitting={assignSubmitting}
                      />
                    </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : viewMode === 'inbox' ? (
          /* ── Inbox view ────────────────────────────────────────────────── */
          <>
            <div style={{
              padding: '14px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>📬 Gmail Inbox</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 3 }}>
                  All emails across all shows
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleSyncInbox}
                disabled={syncingInbox}
              >
                {syncingInbox ? '⟳ Syncing…' : '⟳ Sync Gmail'}
              </button>
              {canRelink && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={openSuggestModal}
                  title="Have the bot look at every unlinked email and suggest a show based on subject, sender, date and body context"
                >
                  🤖 Suggest links
                </button>
              )}
              {canRelink && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleRelinkAll}
                  disabled={relinking}
                  title="Unlink every email and re-match against current shows by date + artist name"
                >
                  {relinking ? '🔗 Re-linking…' : '🔗 Re-link all'}
                </button>
              )}
              <button className="btn btn-primary btn-sm" onClick={() => {
                setReplyData(null)
                setForm({ to: '', cc: '', subject: '', body: '', attachments: [] })
                setComposeOpen(true)
              }}>✉️ Compose</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {selectedIds.size > 0 && (
                <BulkLinkBar
                  count={selectedIds.size}
                  shows={shows}
                  showId={bulkShowId} setShowId={setBulkShowId}
                  showPast={bulkShowPast} setShowPast={setBulkShowPast}
                  submitting={bulkSubmitting}
                  onLink={handleBulkLink}
                  onClear={clearSelection}
                  onSelectAll={() => selectAllVisible(inboxEmails)}
                  onOpenAllShows={() => setAllShowsPickerOpen(true)}
                />
              )}
              {loadingInbox ? (
                <div className="loading">Loading inbox…</div>
              ) : inboxEmails.length === 0 ? (
                <div className="empty-state" style={{ marginTop: 48 }}>
                  Inbox empty. Click <strong>⟳ Sync Gmail</strong> to pull emails.
                </div>
              ) : (
                inboxEmails.map(email => {
                  const isExpanded = expandedId === email.id
                  const atts = getAttachments(email)
                  return (
                    <div key={email.id} style={{
                      margin: '5px 12px', borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: selectedIds.has(email.id)
                        ? 'rgba(59,130,246,0.10)'
                        : (isExpanded ? 'rgba(255,255,255,0.04)' : 'transparent'),
                      overflow: 'hidden',
                    }}>
                      <div onClick={() => handleSelectEmail(email)} style={{
                        padding: '10px 14px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
                      }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(email.id)}
                          onChange={() => toggleSelected(email.id)}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 13, height: 13, margin: '5px 0 0', flexShrink: 0, cursor: 'pointer', accentColor: '#3b82f6' }}
                          title="Select for bulk link"
                        />
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                          background: email.direction === 'outbound' ? '#3b82f6' : '#10b981',
                        }} title={email.direction === 'outbound' ? 'Sent' : 'Received'} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {email.direction === 'outbound' ? `To: ${email.to}` : email.from}
                            </span>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                              {email.showName && (
                                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}>
                                  {email.showName}
                                </span>
                              )}
                              {email.artistName && !email.showName && (
                                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(16,185,129,0.2)', color: '#6ee7b7' }} title="Linked to artist record">
                                  🎤 {email.artistName}
                                </span>
                              )}
                              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>
                                {formatDate(email.date)}
                              </span>
                            </div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>{email.subject}</div>
                          {!isExpanded && (
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {email.snippet}
                            </div>
                          )}
                          {atts.length > 0 && !isExpanded && (
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                              📎 {atts.length} attachment{atts.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={{ padding: '0 14px 14px' }}>
                          {loadingDetail ? (
                            <div className="loading" style={{ padding: '16px 0' }}>Loading…</div>
                          ) : emailDetail ? (
                            <>
                              <iframe
                                srcDoc={emailDetail.htmlBody
                                  ? emailDetail.htmlBody
                                  : `<pre style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;color:#111;margin:0;padding:12px">${emailDetail.textBody || ''}</pre>`}
                                sandbox="allow-same-origin"
                                style={{ width: '100%', border: 'none', minHeight: 180, maxHeight: 520, background: '#fff', borderRadius: 6, display: 'block' }}
                                title="email-body"
                                onLoad={e => {
                                  try {
                                    const h = e.target.contentDocument?.body?.scrollHeight
                                    if (h) e.target.style.height = Math.min(h + 32, 520) + 'px'
                                  } catch { }
                                }}
                              />
                              {emailDetail.attachments?.length > 0 && (
                                <div style={{ marginTop: 10 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Attachments</div>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {emailDetail.attachments.map((att, i) => {
                                      const driveKey = `${email.gmailMessageId}-${att.attachmentId}`
                                      return (
                                        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                          <a href={`/api/emails/attachment?messageId=${email.gmailMessageId}&attachmentId=${att.attachmentId}&filename=${encodeURIComponent(att.filename)}`}
                                            target="_blank" rel="noreferrer"
                                            style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', color: '#93c5fd', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5, border: '1px solid rgba(255,255,255,0.1)' }}>
                                            📎 {att.filename}
                                          </a>
                                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px' }}
                                            onClick={() => handleSaveToDrive(email, att)} disabled={savingToDrive.has(driveKey)} title="Save to show Drive folder">
                                            {savingToDrive.has(driveKey) ? '⏳' : '💾 Drive'}
                                          </button>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <EmailAssignControl
                                  email={email}
                                  advances={advances}
                                  shows={shows}
                                  open={assigningId === email.id}
                                  onToggle={() => setAssigningId(assigningId === email.id ? null : email.id)}
                                  onAssign={handleAssignEmailToShow}
                                  submitting={assignSubmitting}
                                />
                                <button className="btn btn-ghost btn-sm" onClick={() => openReply(email)}>↩ Reply</button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </>
        ) : !selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="empty-state">Select a show to view its email thread</div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div style={{
              padding: '14px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{getShowName(selected)}</div>
                {selected.advanceEmail && (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 3 }}>
                    {selected.advanceContact && <strong>{selected.advanceContact} · </strong>}
                    {selected.advanceEmail}
                    {selected.advancePhone ? ` · ${selected.advancePhone}` : ''}
                  </div>
                )}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleSync}
                disabled={syncing}
                title={!selected.advanceEmail ? 'Add an advance email in the Advancing page first' : ''}
              >
                {syncing ? '⟳ Syncing…' : '⟳ Sync Gmail'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={openCompose}>
                ✉️ Compose
              </button>
            </div>

            {/* Email list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {loadingEmails ? (
                <div className="loading">Loading emails…</div>
              ) : emails.length === 0 ? (
                <div className="empty-state" style={{ marginTop: 48 }}>
                  No emails yet. Click <strong>⟳ Sync Gmail</strong> to pull in existing emails,
                  or <strong>✉️ Compose</strong> to start the thread.
                </div>
              ) : (
                emails.map(email => {
                  const isExpanded = expandedId === email.id
                  const atts = getAttachments(email)

                  return (
                    <div
                      key={email.id}
                      style={{
                        margin: '5px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: isExpanded ? 'rgba(255,255,255,0.04)' : 'transparent',
                        overflow: 'hidden',
                        transition: 'background 0.15s',
                      }}
                    >
                      {/* Collapsed header row */}
                      <div
                        onClick={() => handleSelectEmail(email)}
                        style={{
                          padding: '10px 14px',
                          cursor: 'pointer',
                          display: 'flex',
                          gap: 10,
                          alignItems: 'flex-start',
                        }}
                      >
                        {/* Direction dot: blue = sent, green = received */}
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          marginTop: 5, flexShrink: 0,
                          background: email.direction === 'outbound' ? '#3b82f6' : '#10b981',
                        }} title={email.direction === 'outbound' ? 'Sent' : 'Received'} />

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {email.direction === 'outbound'
                                ? `To: ${email.to}`
                                : email.from}
                            </span>
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                              {formatDate(email.date)}
                            </span>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>{email.subject}</div>
                          {!isExpanded && (
                            <div style={{
                              fontSize: 12, color: 'rgba(255,255,255,0.45)',
                              marginTop: 2, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {email.snippet}
                            </div>
                          )}
                          {atts.length > 0 && !isExpanded && (
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                              📎 {atts.length} attachment{atts.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Expanded body */}
                      {isExpanded && (
                        <div style={{ padding: '0 14px 14px' }}>
                          {loadingDetail ? (
                            <div className="loading" style={{ padding: '16px 0' }}>Loading…</div>
                          ) : emailDetail ? (
                            <>
                              <iframe
                                srcDoc={
                                  emailDetail.htmlBody
                                    ? emailDetail.htmlBody
                                    : `<pre style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;color:#111;margin:0;padding:12px">${emailDetail.textBody || ''}</pre>`
                                }
                                sandbox="allow-same-origin"
                                style={{
                                  width: '100%', border: 'none',
                                  minHeight: 180, maxHeight: 520,
                                  background: '#fff', borderRadius: 6,
                                  display: 'block',
                                }}
                                title="email-body"
                                onLoad={e => {
                                  try {
                                    const h = e.target.contentDocument?.body?.scrollHeight
                                    if (h) e.target.style.height = Math.min(h + 32, 520) + 'px'
                                  } catch { /* cross-origin guard */ }
                                }}
                              />

                              {/* Attachments */}
                              {emailDetail.attachments?.length > 0 && (
                                <div style={{ marginTop: 10 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Attachments
                                  </div>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {emailDetail.attachments.map((att, i) => {
                                      const driveKey = `${email.gmailMessageId}-${att.attachmentId}`
                                      return (
                                        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                          <a
                                            href={`/api/emails/attachment?messageId=${email.gmailMessageId}&attachmentId=${att.attachmentId}&filename=${encodeURIComponent(att.filename)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            style={{
                                              fontSize: 12,
                                              padding: '5px 12px',
                                              borderRadius: 6,
                                              background: 'rgba(255,255,255,0.08)',
                                              color: '#93c5fd',
                                              textDecoration: 'none',
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: 5,
                                              border: '1px solid rgba(255,255,255,0.1)',
                                            }}
                                          >
                                            📎 {att.filename}
                                          </a>
                                          {selected?.showId && (
                                            <button
                                              className="btn btn-ghost btn-sm"
                                              style={{ fontSize: 11, padding: '3px 8px' }}
                                              onClick={() => handleSaveToDrive(email, att)}
                                              disabled={savingToDrive.has(driveKey)}
                                              title="Save to show Drive folder"
                                            >
                                              {savingToDrive.has(driveKey) ? '⏳' : '💾 Drive'}
                                            </button>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}

                              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <EmailAssignControl
                                  email={email}
                                  advances={advances}
                                  shows={shows}
                                  open={assigningId === email.id}
                                  onToggle={() => setAssigningId(assigningId === email.id ? null : email.id)}
                                  onAssign={handleAssignEmailToShow}
                                  submitting={assignSubmitting}
                                />
                                <button className="btn btn-ghost btn-sm" onClick={() => openReply(email)}>
                                  ↩ Reply
                                </button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Compose / Reply modal ────────────────────────────────────────────── */}
      {suggestOpen && (
        <SuggestLinksModal
          loading={suggestLoading}
          applying={suggestApplying}
          rows={suggestRows}
          picked={suggestPicked}
          meta={suggestMeta}
          minConf={suggestMinConf}
          fetchBody={suggestFetchBody}
          onChangeMinConf={(v) => { setSuggestMinConf(v); loadSuggestions(v, suggestFetchBody) }}
          onChangeFetchBody={(v) => { setSuggestFetchBody(v); loadSuggestions(suggestMinConf, v) }}
          onToggle={toggleSuggestPicked}
          onPickAll={() => pickAllSuggested()}
          onPickHigh={() => pickAllSuggested(r => r.suggestion.confidence === 'high')}
          onPickNone={() => setSuggestPicked(new Set())}
          onApply={applySuggestions}
          onClose={() => setSuggestOpen(false)}
        />
      )}
      {allShowsPickerOpen && (
        <AllShowsPicker
          shows={shows}
          onClose={() => setAllShowsPickerOpen(false)}
          onPick={(id) => {
            setBulkShowId(id)
            // Make sure the picked show is visible in the dropdown after pick
            const s = shows.find(x => x.id === id)
            const todayStr = new Date().toISOString().slice(0, 10)
            if (s?.date && s.date < todayStr) setBulkShowPast(true)
            setAllShowsPickerOpen(false)
          }}
        />
      )}
      {composeOpen && (
        <div className="modal-backdrop">
          <div className="modal modal-lg" style={{ display: 'flex', flexDirection: 'column', maxHeight: '85vh' }}>
            <div className="modal-header">
              <h3>{replyData ? '↩ Reply' : '✉️ New Email'}</h3>
              <button className="modal-close" onClick={() => setComposeOpen(false)}>×</button>
            </div>

            <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
              <div className="form-grid">
                <div className="form-row">
                  <div className="form-group">
                    <label>To</label>
                    <input
                      value={form.to}
                      onChange={e => setForm(v => ({ ...v, to: e.target.value }))}
                      placeholder="recipient@email.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>Cc</label>
                    <input
                      value={form.cc}
                      onChange={e => setForm(v => ({ ...v, cc: e.target.value }))}
                      placeholder="cc@email.com"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Subject</label>
                  <input
                    value={form.subject}
                    onChange={e => setForm(v => ({ ...v, subject: e.target.value }))}
                  />
                </div>

                <div className="form-group">
                  <label>Message</label>
                  <textarea
                    value={form.body}
                    onChange={e => setForm(v => ({ ...v, body: e.target.value }))}
                    rows={10}
                    placeholder="Type your message here…"
                    style={{ fontFamily: 'inherit', resize: 'vertical' }}
                  />
                </div>

                <div className="form-group">
                  <label>Attachments</label>

                  {/* Facility Docs quick-attach */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      📁 Facility Docs ({selected?.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'})
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[
                        { key: 'overview',  label: 'Stage Overview & Specs',       icon: '🏟' },
                        { key: 'techpack',  label: 'Full Tech Pack',                icon: '📋' },
                        { key: 'lighting',  label: 'Lighting Patch & Fixture List', icon: '💡' },
                        { key: 'audio',     label: 'Audio Spec Sheet',              icon: '🔊' },
                        { key: 'stageplot', label: 'Stage Plot / Dimensions',       icon: '📐' },
                        { key: 'power',     label: 'Power Distribution',            icon: '⚡' },
                        { key: 'catering',  label: 'Catering / Hospitality Rider',  icon: '🍽' },
                        { key: 'loadinmap', label: 'Load-in Map / Directions',      icon: '🗺' },
                      ].map(dt => (
                        <button
                          key={dt.key}
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 11 }}
                          onClick={() => handleAttachFacilityDoc(dt.key, dt.label)}
                          disabled={loadingFacDocs}
                          title={`Attach ${dt.label} from Tech Pack`}
                        >
                          {dt.icon} {dt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={handleAttachFiles}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    + Browse Files
                  </button>

                  {form.attachments.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {form.attachments.map((a, i) => (
                        <span key={i} style={{
                          fontSize: 12, padding: '3px 10px', borderRadius: 5,
                          background: 'rgba(255,255,255,0.08)',
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}>
                          📎 {a.filename}
                          <button
                            type="button"
                            style={{
                              background: 'none', border: 'none',
                              color: 'rgba(255,255,255,0.45)',
                              cursor: 'pointer', padding: 0, fontSize: 15, lineHeight: 1,
                            }}
                            onClick={() => setForm(v => ({ ...v, attachments: v.attachments.filter((_, j) => j !== i) }))}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setComposeOpen(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={sending || !form.to || !form.subject || !form.body}
              >
                {sending ? 'Sending…' : '✉️ Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Inline component: pick a show to link an inbox email to ────────────────
function SuggestLinksModal({ loading, applying, rows, picked, meta, minConf, fetchBody,
  onChangeMinConf, onChangeFetchBody, onToggle, onPickAll, onPickHigh, onPickNone, onApply, onClose }) {
  const confColor = (c) => c === 'high' ? '#10b981' : c === 'medium' ? '#f59e0b' : '#ef4444'
  return (
    <div className="modal-backdrop">
      <div className="modal modal-lg" style={{ display: 'flex', flexDirection: 'column', maxHeight: '85vh', width: 'min(900px, 95vw)' }}>
        <div className="modal-header">
          <h3>🤖 Bot — Suggested email links</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 10 }}>
            The bot reviewed every unlinked email and matched it to a show using artist name, event name,
            show date, contact email and (optionally) the email body. Confirm the ones you want to link.
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Min confidence:
              <select value={minConf} onChange={(e) => onChangeMinConf(e.target.value)} disabled={loading}>
                <option value="high">High only</option>
                <option value="medium">Medium &amp; up</option>
                <option value="low">All matches</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="Slower — fetches the full Gmail body for up to 50 recent unlinked emails so the bot can use richer context">
              <input type="checkbox" checked={fetchBody} onChange={(e) => onChangeFetchBody(e.target.checked)} disabled={loading} />
              Use full email body
            </label>
            {meta && !loading && (
              <span style={{ marginLeft: 'auto', color: 'rgba(255,255,255,0.5)' }}>
                {meta.suggestionCount} match{meta.suggestionCount !== 1 ? 'es' : ''} from {meta.total} unlinked
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={onPickHigh} disabled={loading || rows.length === 0}>Select high-confidence</button>
            <button className="btn btn-ghost btn-sm" onClick={onPickAll}  disabled={loading || rows.length === 0}>Select all</button>
            <button className="btn btn-ghost btn-sm" onClick={onPickNone} disabled={loading || picked.size === 0}>Clear</button>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{picked.size} selected</span>
          </div>
        </div>
        <div className="modal-body" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading ? (
            <div className="loading">Running bot…</div>
          ) : rows.length === 0 ? (
            <div className="empty-state" style={{ marginTop: 32 }}>
              No suggestions at this confidence level. Try lowering the threshold or enable "Use full email body".
            </div>
          ) : rows.map(r => {
            const sel = picked.has(r.emailId)
            return (
              <label key={r.emailId} style={{
                display: 'flex', gap: 10, padding: '10px 12px', cursor: 'pointer',
                borderRadius: 6, margin: '4px 0',
                background: sel ? 'rgba(59,130,246,0.10)' : 'transparent',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <input type="checkbox" checked={sel} onChange={() => onToggle(r.emailId)} style={{ marginTop: 4 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                      background: confColor(r.suggestion.confidence) + '22',
                      color: confColor(r.suggestion.confidence),
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                      {r.suggestion.confidence}
                    </span>
                    {r.suggestion.showName ? (
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        → {r.suggestion.showName}
                        {r.suggestion.artistName && <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>· 🎤 {r.suggestion.artistName}</span>}
                      </span>
                    ) : r.suggestion.artistName ? (
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        → 🎤 {r.suggestion.artistName}
                        <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 6 }}>(artist only — no dated show matched)</span>
                      </span>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.5)' }}>→ (no target)</span>
                    )}
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginLeft: 'auto' }}>
                      {r.date ? new Date(r.date).toLocaleDateString() : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, color: 'rgba(255,255,255,0.85)' }}>
                    <strong>{r.subject || '(no subject)'}</strong>
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                    {r.from}
                  </div>
                  {r.snippet && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {r.snippet}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 4, fontFamily: 'monospace' }}>
                    matched: {r.suggestion.reason}
                  </div>
                </div>
              </label>
            )
          })}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={applying}>Cancel</button>
          <button className="btn btn-primary" onClick={onApply} disabled={applying || picked.size === 0} style={{ marginLeft: 'auto' }}>
            {applying ? 'Linking…' : `🔗 Link ${picked.size} email${picked.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Inline component: pick a show to link an inbox email to ────────────────
function EmailAssignControl({ email, advances, shows, open, onToggle, onAssign, submitting }) {
  const [showId, setShowId] = useState('')
  const [setAdv, setSetAdv] = useState(true)
  const [showPast, setShowPast] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Build a "Date — Artist/Event" label for each show, sorted by date asc.
  // Hide past shows by default to keep the list focused on what crew is actively working.
  const todayStr = new Date().toISOString().slice(0, 10)
  const options = [...shows]
    .filter(s => showPast || !s.date || s.date >= todayStr)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(s => ({ id: s.id, label: `${s.date || ''} — ${s.artist || s.eventName || s.id}` }))
  // Inject the picked show if it isn't already in the filtered list
  if (showId && !options.find(o => o.id === showId)) {
    const s = shows.find(x => x.id === showId)
    if (s) options.unshift({ id: s.id, label: `${s.date || ''} — ${s.artist || s.eventName || s.id}` })
  }

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm" onClick={onToggle}>
        {email.showName ? `📌 Linked: ${email.showName} — Change…` : '🔗 Link to show…'}
      </button>
    )
  }

  return (
    <>
    {pickerOpen && (
      <AllShowsPicker
        shows={shows}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => {
          setShowId(id)
          const s = shows.find(x => x.id === id)
          if (s?.date && s.date < todayStr) setShowPast(true)
          setPickerOpen(false)
        }}
      />
    )}
    <div style={{
      display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      padding: 8, borderRadius: 6, background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <select
        value={showId}
        onChange={e => {
          const v = e.target.value
          if (v === '__all__') { setPickerOpen(true); return }
          setShowId(v)
        }}
        style={{ padding: '5px 8px', fontSize: 12, minWidth: 220 }}
      >
        <option value="">-- pick a show --</option>
        <option value="__all__">🗂 All shows…</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'rgba(255,255,255,0.55)' }}>
        <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />
        Show all
      </label>
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
        <input type="checkbox" checked={setAdv} onChange={e => setSetAdv(e.target.checked)} />
        Also set sender as advance contact
      </label>
      <button
        className="btn btn-primary btn-sm"
        disabled={!showId || submitting}
        onClick={() => onAssign(email, showId, setAdv)}
      >
        {submitting ? 'Linking…' : 'Link'}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onToggle} disabled={submitting}>Cancel</button>
    </div>
    </>
  )
}
// Lets the user pick a show once and link every selected email to it.
function BulkLinkBar({ count, shows, showId, setShowId, showPast, setShowPast, submitting, onLink, onClear, onSelectAll, onOpenAllShows }) {
  const todayStr = new Date().toISOString().slice(0, 10)
  const options = [...shows]
    .filter(s => showPast || !s.date || s.date >= todayStr)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(s => ({ id: s.id, label: `${s.date || ''} — ${s.artist || s.eventName || s.id}` }))
  // If the selected show isn't in the filtered list (e.g. picked from the All
  // Shows modal), inject it so the dropdown still shows the chosen label.
  if (showId && !options.find(o => o.id === showId)) {
    const s = shows.find(x => x.id === showId)
    if (s) options.unshift({ id: s.id, label: `${s.date || ''} — ${s.artist || s.eventName || s.id}` })
  }

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 5,
      padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      background: 'rgba(59,130,246,0.15)', borderBottom: '1px solid rgba(59,130,246,0.4)',
    }}>
      <strong style={{ fontSize: 13 }}>{count} selected</strong>
      <button className="btn btn-ghost btn-sm" onClick={onSelectAll} title="Add all visible emails to selection">+ All visible</button>
      <select
        value={showId}
        onChange={e => {
          const v = e.target.value
          if (v === '__all__') { onOpenAllShows(); return }
          setShowId(v)
        }}
        style={{ padding: '5px 8px', fontSize: 12, minWidth: 240 }}
      >
        <option value="">-- pick a show --</option>
        <option value="__all__">🗂 All shows…</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'rgba(255,255,255,0.65)' }}>
        <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />
        Show all (incl. past)
      </label>
      <div style={{ flex: 1 }} />
      <button className="btn btn-primary btn-sm" disabled={!showId || submitting} onClick={onLink}>
        {submitting ? 'Linking…' : `🔗 Link ${count} to show`}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onClear} disabled={submitting}>Clear</button>
    </div>
  )
}

// Modal that lists every show (past + future) with a search box.
// Click a row to pick it; the parent receives the show id.
function AllShowsPicker({ shows, onPick, onClose }) {
  const [q, setQ] = useState('')
  const todayStr = new Date().toISOString().slice(0, 10)
  const needle = q.trim().toLowerCase()
  const rows = [...shows]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter(s => {
      if (!needle) return true
      return [s.date, s.artist, s.eventName, s.stage, s.status, s.promoter, s.tourManager]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(needle))
    })

  return (
    <Modal title="Pick a show" onClose={onClose} size="lg">
      <input
        type="text"
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search by date, artist, event, stage, status…"
        style={{ width: '100%', padding: '8px 10px', fontSize: 14, marginBottom: 10 }}
      />
      <div style={{ maxHeight: '55vh', overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6 }}>
        {rows.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>No shows match.</div>
        ) : rows.map(s => {
          const isPast = s.date && s.date < todayStr
          return (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', gap: 10,
                padding: '10px 12px', textAlign: 'left',
                background: 'transparent', color: 'inherit',
                border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)',
                cursor: 'pointer', fontSize: 13,
                opacity: isPast ? 0.7 : 1,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 90 }}>{s.date || '—'}</span>
              <span style={{ flex: 1, fontWeight: 500 }}>{s.artist || s.eventName || '(untitled)'}</span>
              {s.stage && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.08)', textTransform: 'capitalize' }}>{s.stage}</span>}
              {s.status && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.08)', textTransform: 'capitalize' }}>{s.status}</span>}
              {isPast && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>past</span>}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
