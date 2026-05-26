import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'

export default function Dashboard() {
  const [shows, setShows]     = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.get('/shows').then(s => {
      setShows(s.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading">Loading dashboard…</div>

  const today = new Date()
  // Parse YYYY-MM-DD dates as local noon to avoid UTC midnight timezone shifts
  const parseDate = d => d ? new Date(d + 'T12:00:00') : new Date(0)
  const upcoming = shows.filter(s => parseDate(s.date) >= today && s.status !== 'cancelled')
  const thisWeek = upcoming.filter(s => {
    const diff = (parseDate(s.date) - today) / 86400000
    return diff <= 7
  })
  const insideShows = upcoming.filter(s => s.stage === 'inside')
  const beachShows  = upcoming.filter(s => s.stage === 'beach')
  const openAdvances = shows.filter(s => !s.advancingComplete && s.status !== 'cancelled')

  const recentShows = [...shows]
    .sort((a, b) => parseDate(b.date) - parseDate(a.date))
    .slice(0, 8)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">Windjammer — Inside Stage & Beach Stage</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Upcoming Shows</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">{thisWeek.length} this week</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Inside Stage</div>
          <div className="stat-value" style={{ color: '#60aeff' }}>{insideShows.length}</div>
          <div className="stat-sub">upcoming events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Beach Stage</div>
          <div className="stat-value" style={{ color: '#4ade80' }}>{beachShows.length}</div>
          <div className="stat-sub">upcoming events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Open Advances</div>
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{openAdvances.length}</div>
          <div className="stat-sub">need advancing</div>
        </div>

      </div>

      <div className="two-col-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Shows</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>View all</button>
          </div>
          {recentShows.length === 0 ? (
            <div className="empty-state">No shows yet</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Artist / Event</th>
                    <th>Stage</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentShows.map(show => (
                    <tr key={show.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shows/${show.id}`)}>
                      <td className="text-muted">{show.date}</td>
                      <td><strong>{show.artist || show.eventName || '—'}</strong></td>
                      <td>
                        <span className={`badge badge-${show.stage}`}>
                          {show.stage === 'inside' ? 'Inside' : 'Beach'}
                        </span>
                      </td>
                      <td>
                        <span className={`badge badge-${show.status || 'pending'}`}>
                          {show.status || 'pending'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">This Week</span>
          </div>
          {thisWeek.length === 0 ? (
            <div className="empty-state">No shows this week</div>
          ) : (
            <div className="form-grid">
              {thisWeek.map(show => (
                <div key={show.id} onClick={() => navigate(`/shows/${show.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <div style={{ minWidth: 56, fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text)' }}>
                      {new Date(show.date + 'T12:00:00').getDate()}
                    </div>
                    {new Date(show.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{show.artist || show.eventName}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>{show.venue || show.showTime || ''}</div>
                  </div>
                  <span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside' : 'Beach'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
