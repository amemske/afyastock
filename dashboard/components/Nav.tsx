'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, LayoutList, MessageSquare, Wallet } from 'lucide-react';

const SOON = [
  { label: 'Transfers', icon: ArrowLeftRight },
  { label: 'Reorders', icon: Wallet },
  { label: 'Ask AfyaStock', icon: MessageSquare },
];

export default function Nav() {
  const path = usePathname();
  const onAlerts = path === '/' || path.startsWith('/alerts');
  return (
    <nav aria-label="Main">
      <ul className="nav">
        <li>
          <Link href="/" aria-current={onAlerts ? 'page' : undefined}>
            <LayoutList size={18} aria-hidden /> Stock alerts
          </Link>
        </li>
        {SOON.map(({ label, icon: Icon }) => (
          <li key={label}>
            <span className="nav-item soon" aria-disabled="true">
              <Icon size={18} aria-hidden /> {label} <small>Soon</small>
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
