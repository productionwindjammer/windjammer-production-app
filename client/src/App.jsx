import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import UpdatePrompt from './components/UpdatePrompt'
import Login from './pages/Login'
import Onboard from './pages/Onboard'
import Dashboard from './pages/Dashboard'
import Shows from './pages/Shows'
import ShowDetail from './pages/ShowDetail'
import Events from './pages/Events'
import Advancing from './pages/Advancing'
import DayOfShow from './pages/DayOfShow'
import Labor from './pages/Labor'
import Financials from './pages/Financials'
import Maintenance from './pages/Maintenance'
import Budgets from './pages/Budgets'
import Vendors from './pages/Vendors'
import Staff from './pages/Staff'
import StaffDetail from './pages/StaffDetail'
import TechPack from './pages/TechPack'
import Users from './pages/Users'
import Settings from './pages/Settings'
import Calendar from './pages/Calendar'
import Artists from './pages/Artists'
import Email from './pages/Email'
import EmailTemplates from './pages/EmailTemplates'
import { SettingsProvider } from './context/SettingsContext'
import { SplitProvider } from './context/SplitContext'
import { VenueProvider } from './context/VenueContext'

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
            <Route path="/events"      element={<Events />} />
            <Route path="/calendar"    element={<Calendar />} />
            <Route path="/artists"     element={<Artists />} />
            <Route path="/artists/:id" element={<Artists />} />
            <Route path="/advancing"   element={<Advancing />} />
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
            <Route path="/email-templates" element={<EmailTemplates />} />
            <Route path="/settings"    element={<Settings />} />
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
