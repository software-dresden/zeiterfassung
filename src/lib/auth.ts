// Users without an email sign in with a username. Supabase Auth needs an email,
// so a username maps to a synthetic address that is never used for mail. Must
// match SYNTHETIC_EMAIL_DOMAIN in supabase/functions/admin-users/index.ts.
export const SYNTHETIC_EMAIL_DOMAIN = 'users.zeiterfassung.local';

export const identifierToEmail = (identifier: string): string => {
  const trimmed = identifier.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : `${trimmed}@${SYNTHETIC_EMAIL_DOMAIN}`;
};

// Name for reports and signatures: "Vorname Nachname", never an e-mail address. The login
// is a username or an e-mail ("ammar.khous@icloud.com", "a.alkhous"); the part before the
// "@" is split at . _ - and every part capitalised ("Ammar Khous"). A one-letter part
// (an initial) keeps its dot: "A. Alkhous".
export const displayName = (username?: string | null, email?: string | null): string => {
  const raw = (username || email || '').trim();
  const local = raw.includes('@') ? raw.split('@')[0] : raw;
  const parts = local.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length === 0) return 'Techniker';
  return parts
    .map((p) => {
      const cap = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      return p.length === 1 ? `${cap}.` : cap;
    })
    .join(' ');
};
