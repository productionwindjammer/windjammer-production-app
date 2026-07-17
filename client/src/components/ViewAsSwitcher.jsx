import { useAuth } from '../context/AuthContext'

// Admin-only role-perspective switcher. Lets an admin preview the app as a
// production manager, crew member, promoter, or venue manager without
// signing out. Selection is persisted in AuthContext (localStorage).
const VIEW_AS_OPTIONS = [
  { value: '',                   label: 'Admin (me)' },
  { value: 'production_manager', label: 'Production Manager' },
  { value: 'stage_manager',      label: 'Stage Manager' },
  { value: 'venue_management',   label: 'Venue Management' },
  { value: 'promoter',           label: 'Promoter' },
  { value: 'crew',               label: 'Crew' },
]

export default function ViewAsSwitcher() {
  const { isAdmin, viewAsRole, setViewAsRole } = useAuth()
  if (!isAdmin) return null

  return (
    <label className="view-as">
      <span className="view-as-label">View as</span>
      <select
        value={viewAsRole || ''}
        onChange={e => setViewAsRole(e.target.value)}
        title="Preview the app as another role"
      >
        {VIEW_AS_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}
