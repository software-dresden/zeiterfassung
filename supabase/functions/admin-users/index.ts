import { createClient } from 'jsr:@supabase/supabase-js@2';

// Admin-only user management. Runs with the service-role key, which must never
// reach the static client. Every request is authenticated with the caller's JWT
// and then checked against profiles.role = 'admin'.

const SYNTHETIC_EMAIL_DOMAIN = 'users.zeiterfassung.local';
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;
const BAN_FOREVER = '876000h';

// An admin must have passed the authenticator check (JWT claim aal = aal2) to use any
// action. On by default (without it, anyone with an admin password could remove the
// admin's authenticator via resetMfa and enroll their own). Setting the function secret
// REQUIRE_AAL2=false switches it off, e.g. while bootstrapping the first admin.
const REQUIRE_AAL2 = Deno.env.get('REQUIRE_AAL2') !== 'false';

// Assurance level claim of the caller's access token. Only read after getUser() has
// validated the token with the auth server, so the payload can be trusted.
const aalOf = (authHeader: string): string | null => {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const fail = (error: string, status = 400): Response => json({ error }, status);

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Number of enabled admins other than `excludeId`.
const otherActiveAdmins = async (excludeId: string): Promise<number> => {
  const { count } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('disabled', false)
    .neq('id', excludeId);
  return count ?? 0;
};

const translateAuthError = (message: string): string => {
  const lower = message.toLowerCase();
  if (lower.includes('already') || lower.includes('registered') || lower.includes('exists')) {
    return 'Dieser Benutzer existiert bereits.';
  }
  if (lower.includes('password')) return 'Das Passwort wird nicht akzeptiert.';
  if (lower.includes('email')) return 'Die E-Mail-Adresse wird nicht akzeptiert.';
  return message;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return fail('Methode nicht erlaubt.', 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('Nicht angemeldet.', 401);

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return fail('Nicht angemeldet.', 401);
  if (REQUIRE_AAL2 && aalOf(authHeader) !== 'aal2') {
    return fail('Bitte zuerst mit dem Authenticator bestätigen.', 403);
  }

  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, disabled')
    .eq('id', caller.id)
    .maybeSingle();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.disabled) {
    return fail('Keine Berechtigung.', 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('Ungültige Anfrage.');
  }

  const action = body.action;

  if (action === 'list') {
    const [{ data: usersPage, error: listError }, { data: profiles }, { data: entries }] =
      await Promise.all([
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        admin.from('profiles').select('id, username, role, disabled'),
        admin.from('time_entries').select('user_id'),
      ]);
    if (listError) return fail(translateAuthError(listError.message), 500);

    const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
    const entryCounts = new Map<string, number>();
    for (const e of entries ?? []) {
      entryCounts.set(e.user_id, (entryCounts.get(e.user_id) ?? 0) + 1);
    }

    const users = usersPage.users.map((u) => {
      const profile = profileById.get(u.id);
      return {
        id: u.id,
        email: u.email ?? null,
        username: profile?.username ?? null,
        role: profile?.role ?? null,
        disabled: profile?.disabled ?? false,
        has_profile: !!profile,
        mfa_enabled: (u.factors ?? []).some((f) => f.status === 'verified'),
        providers: (u.app_metadata?.providers as string[] | undefined) ?? [],
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        entry_count: entryCounts.get(u.id) ?? 0,
      };
    });
    return json({ users });
  }

  if (action === 'create') {
    const identifier = String(body.identifier ?? '').trim();
    const password = String(body.password ?? '');
    const role = body.role === 'admin' ? 'admin' : 'user';

    if (password.length < MIN_PASSWORD_LENGTH) {
      return fail(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    }

    let email: string;
    let username: string | null = null;
    if (identifier.includes('@')) {
      email = identifier.toLowerCase();
      if (!EMAIL_PATTERN.test(email)) return fail('Ungültige E-Mail-Adresse.');
    } else {
      username = identifier.toLowerCase();
      if (!USERNAME_PATTERN.test(username)) {
        return fail('Benutzername: 3–32 Zeichen, nur a–z, 0–9, Punkt, Unterstrich und Bindestrich.');
      }
      email = `${username}@${SYNTHETIC_EMAIL_DOMAIN}`;
    }

    if (username) {
      const { data: taken } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();
      if (taken) return fail('Dieser Benutzername ist bereits vergeben.');
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: username ? { username } : {},
    });
    if (createError || !created.user) {
      return fail(translateAuthError(createError?.message ?? 'Benutzer konnte nicht angelegt werden.'));
    }

    const { error: profileError } = await admin
      .from('profiles')
      .insert({ id: created.user.id, username, role });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return fail('Profil konnte nicht angelegt werden.', 500);
    }

    return json({ ok: true, id: created.user.id });
  }

  const userId = String(body.user_id ?? '');
  if (!userId) return fail('Benutzer fehlt.');

  // Change the login (username or e-mail) and/or the role of a user. Time entries belong
  // to the user id, so nothing is lost when the login changes. The user stays signed in.
  if (action === 'update') {
    const { data: target } = await admin
      .from('profiles')
      .select('username, role')
      .eq('id', userId)
      .maybeSingle();
    if (!target) return fail('Dieser Benutzer hat keinen Zugang.');

    const authUpdate: { email?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> } = {};
    const profileUpdate: { username?: string | null; role?: string } = {};

    if (typeof body.identifier === 'string') {
      const identifier = body.identifier.trim();
      let email: string;
      let username: string | null = null;
      if (identifier.includes('@')) {
        email = identifier.toLowerCase();
        if (!EMAIL_PATTERN.test(email)) return fail('Ungültige E-Mail-Adresse.');
      } else {
        username = identifier.toLowerCase();
        if (!USERNAME_PATTERN.test(username)) {
          return fail('Benutzername: 3–32 Zeichen, nur a–z, 0–9, Punkt, Unterstrich und Bindestrich.');
        }
        email = `${username}@${SYNTHETIC_EMAIL_DOMAIN}`;
      }
      if (username) {
        const { data: taken } = await admin
          .from('profiles')
          .select('id')
          .eq('username', username)
          .neq('id', userId)
          .maybeSingle();
        if (taken) return fail('Dieser Benutzername ist bereits vergeben.');
      }
      authUpdate.email = email;
      authUpdate.email_confirm = true;
      authUpdate.user_metadata = { username };
      profileUpdate.username = username;
    }

    if (body.role === 'admin' || body.role === 'user') {
      if (body.role !== target.role) {
        if (userId === caller.id) return fail('Sie können Ihre eigene Rolle nicht ändern.');
        if (target.role === 'admin' && (await otherActiveAdmins(userId)) === 0) {
          return fail('Der letzte aktive Administrator kann nicht herabgestuft werden.');
        }
        profileUpdate.role = body.role;
      }
    }

    if (Object.keys(authUpdate).length > 0) {
      const { error } = await admin.auth.admin.updateUserById(userId, authUpdate);
      if (error) return fail(translateAuthError(error.message));
    }
    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await admin.from('profiles').update(profileUpdate).eq('id', userId);
      if (error) return fail('Änderung konnte nicht gespeichert werden.', 500);
    }
    return json({ ok: true });
  }

  if (action === 'setPassword') {
    const password = String(body.password ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return fail(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    }
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return fail(translateAuthError(error.message));
    return json({ ok: true });
  }

  // Lost phone: remove every authenticator of the user. Deleting a verified factor also
  // signs them out everywhere; at the next sign-in they set up a new authenticator.
  if (action === 'resetMfa') {
    const { data, error: listError } = await admin.auth.admin.mfa.listFactors({ userId });
    if (listError) return fail(translateAuthError(listError.message), 500);
    let removed = 0;
    for (const factor of data.factors) {
      const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
      if (deleteError) return fail(translateAuthError(deleteError.message), 500);
      removed += 1;
    }
    return json({ ok: true, removed });
  }

  if (action === 'setDisabled') {
    const disabled = body.disabled === true;
    if (disabled) {
      if (userId === caller.id) return fail('Sie können sich nicht selbst deaktivieren.');
      const { data: target } = await admin
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
      if (target?.role === 'admin' && (await otherActiveAdmins(userId)) === 0) {
        return fail('Der letzte aktive Administrator kann nicht deaktiviert werden.');
      }
    }
    const { error: profileError } = await admin
      .from('profiles')
      .update({ disabled })
      .eq('id', userId);
    if (profileError) return fail('Status konnte nicht geändert werden.', 500);
    const { error: banError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: disabled ? BAN_FOREVER : 'none',
    });
    if (banError) return fail(translateAuthError(banError.message), 500);
    return json({ ok: true });
  }

  if (action === 'delete') {
    if (userId === caller.id) return fail('Sie können sich nicht selbst löschen.');
    const { data: target } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (target?.role === 'admin' && (await otherActiveAdmins(userId)) === 0) {
      return fail('Der letzte aktive Administrator kann nicht gelöscht werden.');
    }
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return fail(translateAuthError(error.message), 500);
    return json({ ok: true });
  }

  return fail('Unbekannte Aktion.');
});
