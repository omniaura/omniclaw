import { A, useLocation } from '@solidjs/router';
import { For } from 'solid-js';

import StatusBadge from '~/components/StatusBadge';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/agents', label: 'Agents' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/logs', label: 'Logs' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/context', label: 'Context' },
  { href: '/ipc', label: 'IPC' },
  { href: '/network', label: 'Network' },
  { href: '/system', label: 'System' },
  { href: '/settings', label: 'Settings' },
];

export default function Nav() {
  const location = useLocation();

  function isActive(href: string): boolean {
    if (href === '/') return location.pathname === '/';
    return location.pathname.startsWith(href);
  }

  return (
    <header class="flex items-center h-10 px-4 bg-surface border-b border-border shrink-0">
      <div class="text-accent font-semibold text-sm mr-6">omniclaw</div>
      <nav class="flex items-center gap-1 overflow-x-auto flex-1">
        <For each={NAV_ITEMS}>
          {(item) => (
            <A
              href={item.href}
              class={`px-2 py-1 rounded text-xs transition-colors whitespace-nowrap ${
                isActive(item.href)
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-dim hover:text-text hover:bg-surface-2'
              }`}
            >
              {item.label}
            </A>
          )}
        </For>
      </nav>
      <div class="ml-4">
        <StatusBadge />
      </div>
    </header>
  );
}
