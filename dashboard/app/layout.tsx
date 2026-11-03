import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { MapPin } from 'lucide-react';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import './globals.css';
import BrandMark from '@/components/BrandMark';
import Nav from '@/components/Nav';
import { api, type Overview } from '@/lib/api';
import { monthYear } from '@/lib/format';

export const metadata: Metadata = {
  title: 'AfyaStock',
  description: 'Early warning for essential-medicine stockouts at district level.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let overview: Overview | null = null;
  try {
    overview = await api.overview();
  } catch {
    // The page itself shows the error; the shell still renders.
  }
  const region = overview?.region?.replace(/\s*\(fictional\)\s*$/i, '') ?? 'District';

  return (
    // suppressHydrationWarning: browser extensions (e.g. grammar checkers) add attributes to <html>.
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <Link href="/" className="brand">
              <BrandMark />
              <span className="brand-name">
                AfyaStock <span className="brand-sub">Medicine stock early warning</span>
              </span>
            </Link>
            <Nav />
            <div className="sidebar-foot">
              {overview?.latestRun && <>Forecast updated with reports up to {monthYear(overview.latestRun.data_until)}.</>}
            </div>
          </aside>

          <div className="main">
            <header className="topbar">
              <Link href="/" className="brand" aria-label="AfyaStock home">
                <BrandMark size={28} />
                <span className="brand-name">AfyaStock</span>
              </Link>
              <div className="topbar-context">
                <MapPin size={16} aria-hidden />
                <strong>{region}</strong>
                <span className="hide-sm">{overview ? `${overview.locations} facilities` : ''}</span>
              </div>
              <div className="user-chip">
                <span className="avatar" aria-hidden>
                  DP
                </span>
                <span className="who">District pharmacist</span>
              </div>
            </header>
            <div className="content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
