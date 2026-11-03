'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, LayoutList, MessageSquare, Wallet } from 'lucide-react';

const LINKS = [
  { href: '/', label: 'Stock alerts', icon: LayoutList, match: (p: string) => p === '/' || p.startsWith('/alerts') },
  { href: '/transfers', label: 'Transfers', icon: ArrowLeftRight, match: (p: string) => p.startsWith('/transfers') },
  { href: '/reorders', label: 'Reorders', icon: Wallet, match: (p: string) => p.startsWith('/reorders') },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="nav">
        {LINKS.map(({ href, label, icon: Icon, match }) => (
          <li key={href}>
            <Link href={href} aria-current={match(path) ? 'page' : undefined}>
              <Icon size={18} aria-hidden /> {label}
            </Link>
          </li>
        ))}
        <li>
          <span className="nav-item soon" aria-disabled="true">
            <MessageSquare size={18} aria-hidden /> Ask AfyaStock <small>Soon</small>
          </span>
        </li>
      </ul>
    </nav>
  );
}
