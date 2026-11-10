import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { AdminUser, UserRole } from '@/types';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

// All user management goes through the admin-users edge function, which checks
// on the server that the caller is an admin. Nothing here is offline-capable.
const call = async <T>(body: Record<string, unknown>): Promise<ApiResult<T>> => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, error: 'Die Benutzerverwaltung benötigt eine Internetverbindung.' };
  }

  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      try {
        const payload = await error.context.json();
        if (payload && typeof payload.error === 'string') return { ok: false, error: payload.error };
      } catch {
        // fall through to the generic message
      }
    }
    return { ok: false, error: 'Anfrage fehlgeschlagen. Bitte erneut versuchen.' };
  }
  return { ok: true, data: data as T };
};

export const listUsers = async (): Promise<ApiResult<AdminUser[]>> => {
  const result = await call<{ users: AdminUser[] }>({ action: 'list' });
  return result.ok ? { ok: true, data: result.data.users } : result;
};

export const createUser = (input: { identifier: string; password: string; role: UserRole }) =>
  call<{ id: string }>({ action: 'create', ...input });

// Change the login (username or e-mail) and/or the role. Time entries stay with the user.
export const updateUser = (userId: string, changes: { identifier?: string; role?: UserRole }) =>
  call<{ ok: true }>({ action: 'update', user_id: userId, ...changes });

export const setUserPassword = (userId: string, password: string) =>
  call<{ ok: true }>({ action: 'setPassword', user_id: userId, password });

export const setUserDisabled = (userId: string, disabled: boolean) =>
  call<{ ok: true }>({ action: 'setDisabled', user_id: userId, disabled });

// Lost phone: removes all authenticators of the user (they set up a new one at the next sign-in).
export const resetUserMfa = (userId: string) =>
  call<{ ok: true; removed: number }>({ action: 'resetMfa', user_id: userId });

export const deleteUser = (userId: string) =>
  call<{ ok: true }>({ action: 'delete', user_id: userId });
