'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { clearPresence } from '@/lib/presence';
import { useProfile } from '@/hooks/useProfile';
import { SyncStatus } from './SyncStatus';
import { SyncStatus as SyncStatusType } from '@/types';
import { Logo } from './Logo';
import {
  HouseIcon,
  PlusCircleIcon,
  ListIcon,
  BarChartIcon,
  GearIcon,
  LogoutIcon,
  ShieldIcon,
} from './icons';

const navItems = [
  { label: 'Dashboard', href: '/', icon: HouseIcon },
  { label: 'Neue Erfassung', href: '/new-entry', icon: PlusCircleIcon },
  { label: 'Sessions', href: '/sessions', icon: ListIcon },
  { label: 'Reports', href: '/report', icon: BarChartIcon },
  { label: 'Einstellungen', href: '/settings', icon: GearIcon },
];

const adminNavItem = { label: 'Admin', href: '/admin', icon: ShieldIcon };

interface TopNavProps {
  syncStatus: SyncStatusType;
}

export const TopNav = ({ syncStatus }: TopNavProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const { isAdmin } = useProfile();
  const visibleNavItems = isAdmin ? [...navItems, adminNavItem] : navItems;

  const handleLogout = async () => {
    await clearPresence();
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto max-w-5xl px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Logo className="h-9 w-9 shrink-0 rounded-xl" />
            <span className="text-lg font-bold tracking-tight text-text">Zeiterfassung</span>
          </div>
          <div className="flex items-center gap-3">
            <SyncStatus status={syncStatus} />
            <button
              onClick={handleLogout}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-text-muted transition-colors duration-150 ease-out hover:text-danger"
              aria-label="Abmelden"
            >
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1">
          {visibleNavItems.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-150 ease-out',
                  active
                    ? 'bg-accent-dim text-accent'
                    : 'text-text-muted hover:bg-surface-2 hover:text-text',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
