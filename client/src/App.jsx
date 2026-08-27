import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import UpdatePrompt from './components/UpdatePrompt'
import Login from './pages/Login'
import Onboard from './pages/Onboard'
import Dashboard from './pages/Dashboard'
import Shows from './pages/Shows'
import ShowDetail from './pages/ShowDetail'
import ShowBrief from './pages/ShowBrief'
import Events from './pages/Events'
import EventSchedule from './pages/EventSchedule'
import Advancing from './pages/Advancing'
import AdvancingHub from './pages/AdvancingHub'
import DayOfShow from './pages/DayOfShow'
import Labor from './pages/Labor'
import Financials from './pages/Financials'
import Maintenance from './pages/Maintenance'
import Budgets from './pages/Budgets'
import Vendors from './pages/Vendors'
import Staff from './pages/Staff'
import StaffDetail from './pages/StaffDetail'
import TechPack from './pages/TechPack'
import VenueKnowledge from './pages/VenueKnowledge'
import VenueKnowledgeReview from './pages/VenueKnowledgeReview'
import IndustryKnowledge from './pages/IndustryKnowledge'
import Users from './pages/Users'
import Settings from './pages/Settings'
import Calendar from './pages/Calendar'
import Artists from './pages/Artists'
import Email from './pages/Email'
import EmailIntel from './pages/EmailIntel'
import EmailTemplates from './pages/EmailTemplates'
import AdvancementDashboard from './pages/AdvancementDashboard'
import AdvanceIntel from './pages/AdvanceIntel'
import { SettingsProvider } from './context/SettingsContext'
import { SplitProvider } from './context/SplitContext'
import { VenueProvider } from './context/VenueContext'

// Preserves ?query and #hash when redirecting a legacy path into the hub.
function LegacyRedirect({ to }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}

export default function App() {
  return (
    <SettingsProvider>
    <AuthProvider>
    <VenueProvider>
    <SplitProvider>
      <BrowserRouter>
        <UpdatePrompt />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/onboard/:token" element={<Onboard />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard"   element={<Dashboard />} />
            <Route path="/shows"       element={<Shows />} />
            <Route path="/shows/:id"   element={<ShowDetail />} />
            <Route path="/shows/:id/brief" element={<ShowBrief />} />
            <Route path="/events"      element={<Events />} />
            <Route path="/events/:id/schedule" element={<EventSchedule />} />
            <Route path="/calendar"    element={<Calendar />} />
            <Route path="/artists"     element={<Artists />} />
            <Route path="/artists/:id" element={<Artists />} />
            <Route path="/advancing" element={<AdvancingHub />}>
              <Route index                    element={<Advancing />} />
              <Route path="advancement"       element={<AdvancementDashboard />} />
              <Route path="advance-intel"     element={<AdvanceIntel />} />
              <Route path="email-intel"       element={<EmailIntel />} />
              <Route path="email-templates"   element={<EmailTemplates />} />
              <Route path="venue-intel"       element={<VenueKnowledge />} />
              <Route path="knowledge-review"  element={<VenueKnowledgeReview />} />
              <Route path="industry-knowledge" element={<IndustryKnowledge />} />
            </Route>
            <Route path="/day-of-show" element={<DayOfShow />} />
            <Route path="/labor"       element={<Labor />} />
            <Route path="/financials"  element={<Financials />} />
            <Route path="/maintenance" element={<Maintenance />} />
            <Route path="/budgets"     element={<Budgets />} />
            <Route path="/vendors"     element={<Vendors />} />
            <Route path="/staff"       element={<Staff />} />
            <Route path="/staff/:id"   element={<StaffDetail />} />
            <Route path="/users"       element={<Users />} />
            <Route path="/tech-pack"   element={<TechPack />} />
            <Route path="/email"       element={<Email />} />
            <Route path="/settings"    element={<Settings />} />
            {/* Legacy redirects: previous top-level routes now live under /advancing. */}
            <Route path="/advancement"            element={<LegacyRedirect to="/advancing/advancement" />} />
            <Route path="/advance-intel"          element={<LegacyRedirect to="/advancing/advance-intel" />} />
            <Route path="/email-intel"            element={<LegacyRedirect to="/advancing/email-intel" />} />
            <Route path="/email-templates"        element={<LegacyRedirect to="/advancing/email-templates" />} />
            <Route path="/venue-knowledge"        element={<LegacyRedirect to="/advancing/venue-intel" />} />
            <Route path="/venue-knowledge-review" element={<LegacyRedirect to="/advancing/knowledge-review" />} />
            <Route path="/industry-knowledge"     element={<LegacyRedirect to="/advancing/industry-knowledge" />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </SplitProvider>
    </VenueProvider>
    </AuthProvider>
    </SettingsProvider>
  )
}
