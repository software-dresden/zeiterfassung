'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserMfa,
  setUserDisabled,
  setUserPassword,
  updateUser,
} from '@/lib/adminApi';
import { useProfile } from '@/hooks/useProfile';
import { useToast } from '@/components/ui/Toast';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { TemplateSettings } from '@/components/admin/TemplateSettings';
import { KeyIcon, PeopleIcon, PowerIcon, ShieldIcon, TrashIcon } from '@/components/nav/icons';
import { AdminUser, UserRole } from '@/types';

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('de-DE') : '—';

const displayName = (user: AdminUser): string => user.username ?? user.email ?? user.id;

export default function AdminPage() {
  const { isAdmin, loading: profileLoading } = useProfile();
  const { showToast } = useToast();

  const [selfId, setSelfId] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [creating, setCreating] = useState(false);

  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [editIdentifier, setEditIdentifier] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('user');
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [mfaTarget, setMfaTarget] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSelfId(data.session?.user.id ?? null));
  }, []);

  const reload = useCallback(async () => {
    const result = await listUsers();
    if (result.ok) {
      setUsers(result.data);
      setLoadError('');
    } else {
      setLoadError(result.error);
    }
    setLoadingUsers(false);
  }, []);

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    const result = await createUser({ identifier, password, role });
    setCreating(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    setIdentifier('');
    setPassword('');
    setRole('user');
    showToast('Benutzer angelegt', 'success');
    reload();
  };

  const openEdit = (user: AdminUser) => {
    setEditTarget(user);
    setEditIdentifier(user.username ?? user.email ?? '');
    setEditRole(user.role ?? 'user');
  };

  const handleEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    const changes: { identifier?: string; role?: UserRole } = {};
    const current = editTarget.username ?? editTarget.email ?? '';
    if (editIdentifier.trim().toLowerCase() !== current.toLowerCase()) changes.identifier = editIdentifier;
    if (editRole !== editTarget.role) changes.role = editRole;
    if (Object.keys(changes).length === 0) {
      setEditTarget(null);
      return;
    }
    setBusy(true);
    const result = await updateUser(editTarget.id, changes);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    setEditTarget(null);
    showToast('Benutzer geändert', 'success');
    reload();
  };

  const handleSetPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!passwordTarget) return;
    setBusy(true);
    const result = await setUserPassword(passwordTarget.id, newPassword);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    setPasswordTarget(null);
    setNewPassword('');
    showToast('Passwort geändert', 'success');
  };

  const handleToggleDisabled = async (user: AdminUser) => {
    const result = await setUserDisabled(user.id, !user.disabled);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    showToast(user.disabled ? 'Benutzer aktiviert' : 'Benutzer deaktiviert', 'success');
    reload();
  };

  const handleResetMfa = async () => {
    if (!mfaTarget) return;
    setBusy(true);
    const result = await resetUserMfa(mfaTarget.id);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    setMfaTarget(null);
    showToast('MFA zurückgesetzt', 'success');
    reload();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    const result = await deleteUser(deleteTarget.id);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    setDeleteTarget(null);
    showToast('Benutzer gelöscht', 'success');
    reload();
  };

  if (profileLoading) return null;

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldIcon className="h-5 w-5" />}
        title="Kein Zugriff"
        description="Dieser Bereich ist nur für Administratoren."
      />
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Wer das System nutzen darf
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-text">Administration</h1>
      </div>

      <section>
        <div className="mb-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Neuer Zugang
          </p>
          <h2 className="text-xl font-bold text-text">Benutzer anlegen</h2>
        </div>

        <form
          onSubmit={handleCreate}
          className="flex flex-wrap items-end gap-3 rounded-3xl border border-border bg-surface p-4"
        >
          <Input
            label="Benutzername oder E-Mail *"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoCapitalize="none"
            autoComplete="off"
            required
          />
          <Input
            label="Passwort * (min. 12 Zeichen)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
          <Select label="Rolle" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="user">Benutzer</option>
            <option value="admin">Administrator</option>
          </Select>
          <Button type="submit" disabled={creating}>
            {creating ? 'Wird angelegt...' : '+ Benutzer anlegen'}
          </Button>
        </form>
        <p className="mt-2 text-xs text-text-muted">
          Ein Benutzername (z. B. &bdquo;anna&ldquo;) genügt. Eine E-Mail-Adresse ist nicht nötig.
        </p>
      </section>

      <section>
        <div className="mb-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Alle Zugänge
          </p>
          <h2 className="text-xl font-bold text-text">Benutzer</h2>
        </div>

        {loadError && <p className="mb-3 text-sm text-danger">{loadError}</p>}

        {loadingUsers ? (
          <p className="text-sm text-text-muted">Laden...</p>
        ) : users.length === 0 ? (
          <EmptyState
            icon={<PeopleIcon className="h-5 w-5" />}
            title="Keine Benutzer"
            description="Legen Sie oben den ersten Benutzer an."
          />
        ) : (
          <div className="overflow-hidden rounded-3xl border border-border bg-surface">
            {users.map((user) => {
              const isSelf = user.id === selfId;
              return (
                <div
                  key={user.id}
                  className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 last:border-b-0 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-text" title={displayName(user)}>
                        {displayName(user)}
                      </p>
                      {isSelf && <Badge>Sie</Badge>}
                      {user.role === 'admin' && <Badge variant="success">Administrator</Badge>}
                      {user.disabled && <Badge variant="danger">Deaktiviert</Badge>}
                      {!user.has_profile && <Badge variant="warning">Kein Zugang</Badge>}
                      {user.has_profile && (
                        <Badge variant={user.mfa_enabled ? 'success' : 'warning'}>
                          {user.mfa_enabled ? 'MFA aktiv' : 'MFA fehlt'}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-text-muted">
                      {user.username && user.email ? `${user.email} · ` : ''}
                      {user.providers.includes('github') ? 'GitHub · ' : ''}
                      {user.entry_count} Einträge · zuletzt angemeldet {formatDate(user.last_sign_in_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {user.has_profile && (
                      <IconButton label="Anmeldename / Rolle ändern" onClick={() => openEdit(user)}>
                        <PeopleIcon className="h-4 w-4" />
                      </IconButton>
                    )}
                    <IconButton
                      label="Passwort ändern"
                      onClick={() => {
                        setPasswordTarget(user);
                        setNewPassword('');
                      }}
                    >
                      <KeyIcon className="h-4 w-4" />
                    </IconButton>
                    {user.mfa_enabled && (
                      <IconButton label="MFA zurücksetzen" onClick={() => setMfaTarget(user)}>
                        <ShieldIcon className="h-4 w-4" />
                      </IconButton>
                    )}
                    {user.has_profile && !isSelf && (
                      <IconButton
                        label={user.disabled ? 'Aktivieren' : 'Deaktivieren'}
                        onClick={() => handleToggleDisabled(user)}
                      >
                        <PowerIcon className="h-4 w-4" />
                      </IconButton>
                    )}
                    {!isSelf && (
                      <IconButton label="Löschen" variant="danger" onClick={() => setDeleteTarget(user)}>
                        <TrashIcon className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <TemplateSettings />

      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={editTarget ? `Benutzer ändern: ${displayName(editTarget)}` : undefined}
      >
        <form onSubmit={handleEdit} className="flex flex-col gap-4">
          <Input
            label="Benutzername oder E-Mail"
            value={editIdentifier}
            onChange={(e) => setEditIdentifier(e.target.value)}
            autoCapitalize="none"
            autoComplete="off"
            required
            fullWidth
          />
          {editTarget?.id !== selfId && (
            <Select
              label="Rolle"
              value={editRole}
              onChange={(e) => setEditRole(e.target.value as UserRole)}
              fullWidth
            >
              <option value="user">Benutzer</option>
              <option value="admin">Administrator</option>
            </Select>
          )}
          <p className="text-xs text-text-muted">
            Zeiteinträge und Passwort bleiben erhalten. Der Benutzer meldet sich künftig mit dem neuen
            Namen an; ein bereits angemeldetes Gerät bleibt angemeldet. Der Name im Bericht
            (&bdquo;Techniker&ldquo;) wird aus dem Anmeldenamen abgeleitet.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Speichern
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>
              Abbrechen
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!passwordTarget}
        onClose={() => setPasswordTarget(null)}
        title={passwordTarget ? `Passwort ändern: ${displayName(passwordTarget)}` : undefined}
      >
        <form onSubmit={handleSetPassword} className="flex flex-col gap-4">
          <Input
            label="Neues Passwort (min. 12 Zeichen)"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
            fullWidth
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Speichern
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPasswordTarget(null)}>
              Abbrechen
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Benutzer löschen"
      >
        {deleteTarget && (
          <>
            <p className="mb-4 text-sm text-text">
              <span className="font-semibold">{displayName(deleteTarget)}</span> wird endgültig
              gelöscht
              {deleteTarget.entry_count > 0
                ? `, samt ${deleteTarget.entry_count} Zeiteinträgen. Das lässt sich nicht rückgängig machen.`
                : '.'}
            </p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={handleDelete} disabled={busy}>
                Löschen
              </Button>
              <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                Abbrechen
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!mfaTarget} onClose={() => setMfaTarget(null)} title="MFA zurücksetzen">
        {mfaTarget && (
          <>
            <p className="mb-4 text-sm text-text">
              Der Authenticator von <span className="font-semibold">{displayName(mfaTarget)}</span> wird
              entfernt, zum Beispiel weil das Handy verloren ging. Der Benutzer wird überall abgemeldet
              und richtet beim nächsten Anmelden einen neuen Authenticator ein.
            </p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={handleResetMfa} disabled={busy}>
                Zurücksetzen
              </Button>
              <Button variant="secondary" onClick={() => setMfaTarget(null)}>
                Abbrechen
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
