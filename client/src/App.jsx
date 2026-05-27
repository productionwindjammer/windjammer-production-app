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
import Advancing from './pages/Advancing'
import DayOfShow from './pages/DayOfShow'
import Vendors from './pages/Vendors'
import Staff from './pages/Staff'
import TechPack from './pages/TechPack'
import Email from './pages/Email'
import Users from './pages/Users'
import Settings from './pages/Settings'
import Calendar from './pages/Calendar'
import Artists from './pages/Artists'
import { SettingsProvider } from './context/SettingsContext'
import { SplitProvider } from './context/SplitContext'

export default function App() {
  return (
    <SettingsProvider>
    <AuthProvider>
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
            <Route path="/calendar"    element={<Calendar />} />
            <Route path="/artists"     element={<Artists />} />
            <Route path="/artists/:id" element={<Artists />} />
            <Route path="/advancing"   element={<Advancing />} />
            <Route path="/day-of-show" element={<DayOfShow />} />
            <Route path="/vendors"     element={<Vendors />} />
            <Route path="/staff"       element={<Staff />} />
            <Route path="/users"       element={<Users />} />
            <Route path="/tech-pack"   element={<TechPack />} />
            <Route path="/email"        element={<Email />} />
            <Route path="/settings"    element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </SplitProvider>
    </AuthProvider>
    </SettingsProvider>
  )
}
