// Compose an onboarding invite in the admin's default email client.
// The server issues the signed invite URL; delivery is handled locally
// via a `mailto:` link so we don't depend on a house Gmail mailbox.

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there'
}

export function buildInviteMailto({ to, name, inviteUrl }) {
  const subject = 'Welcome to Windjammer — Complete Your Profile'
  const lines = [
    `Hi ${firstName(name)},`,
    '',
    'Welcome to the Windjammer Production team! Please finish setting up your account by opening the link below:',
    '',
    inviteUrl || '',
    '',
    'This link is valid for 7 days. You will be asked to set a password and fill in a few details — once you log in successfully, you are all set.',
    '',
    'Tip: on your phone, open the link and then use "Add to Home Screen" (iPhone/Safari) or "Install app" (Android/Chrome) to get a full-screen app icon.',
    '',
    '— The Windjammer Production Team',
  ]
  const body = lines.join('\r\n')
  const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return `mailto:${encodeURIComponent(to || '')}?${q}`
}

export function openInviteMail({ to, name, inviteUrl }) {
  if (!to || !inviteUrl) return
  const href = buildInviteMailto({ to, name, inviteUrl })
  // Use a hidden anchor so popup blockers treat this as a user-initiated navigation.
  try {
    const a = document.createElement('a')
    a.href = href
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch {
    window.location.href = href
  }
}
