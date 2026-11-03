import type { AlertStatus } from './api';

export const STATUS: Record<AlertStatus, { label: string; short: string }> = {
  out_now: { label: 'Out of stock now', short: 'Out now' },
  within_30: { label: 'Likely to run out within 30 days', short: 'Within 30 days' },
  within_60: { label: 'Likely to run out within 60 days', short: 'Within 60 days' },
  expiry: { label: 'Stock likely to expire unused', short: 'Expiring' },
};

export const STATUS_ORDER: AlertStatus[] = ['out_now', 'within_30', 'within_60', 'expiry'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-01' -> 'Oct 2026' (no timezone surprises: parsed by hand). */
export function monthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** '2026-10-01' -> 'Oct 26' for chart axes. */
export function monthShort(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

export function placeType(t: string): string {
  return { dispensary: 'Dispensary', health_centre: 'Health centre', hospital: 'Hospital' }[t] ?? t;
}

/** How long stock lasts, in words a pharmacist uses. */
export function cover(monthsOfStock: number | null): string {
  if (monthsOfStock === null) return '';
  if (monthsOfStock <= 0) return 'No stock';
  const weeks = monthsOfStock * 4.3;
  if (weeks < 1) return 'Under a week of stock';
  if (weeks < 8) return `About ${Math.round(weeks)} week${Math.round(weeks) === 1 ? '' : 's'} of stock`;
  return `About ${Math.round(monthsOfStock)} months of stock`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function num(x: number): string {
  return new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(x);
}

export function kes(x: number): string {
  return `KES ${new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(x)}`;
}

export const VEN: Record<string, string> = { V: 'Vital', E: 'Essential', N: 'Non-essential' };

/** Urgency (alert horizon in days) -> status key used for colours. */
export function urgencyStatus(days: number): 'out_now' | 'within_30' | 'within_60' {
  return days <= 0 ? 'out_now' : days <= 30 ? 'within_30' : 'within_60';
}

/** 1 inhaler, 5 inhalers. */
export function qty(n: number, unit: string): string {
  return `${num(n)} ${unit}${Math.round(n) === 1 ? '' : 's'}`;
}
