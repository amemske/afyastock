import Link from 'next/link';
import { CalendarClock, ChevronRight, Clock, Hourglass, Info, PackageX } from 'lucide-react';
import { api, type AlertStatus } from '@/lib/api';
import { STATUS, STATUS_ORDER, monthYear, pct } from '@/lib/format';

const PAGE = 50;
const ICONS = { out_now: PackageX, within_30: Clock, within_60: CalendarClock, expiry: Hourglass };

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export default async function AlertsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const status = (STATUS_ORDER as string[]).includes(one(sp.status)) ? (one(sp.status) as AlertStatus) : undefined;
  const locationId = one(sp.location_id);
  const itemId = one(sp.item_id);
  const limit = Math.min(Math.max(Number(one(sp.limit)) || PAGE, PAGE), 200);

  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (locationId) q.set('location_id', locationId);
  if (itemId) q.set('item_id', itemId);
  q.set('limit', String(limit));

  const [overview, places, medicines, list] = await Promise.all([
    api.overview(),
    api.locations(),
    api.items(),
    api.alerts(q),
  ]);

  const href = (changes: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status, location_id: locationId, item_id: itemId, ...changes };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };

  const place = places.find((p) => String(p.id) === locationId);
  const medicine = medicines.find((m) => String(m.id) === itemId);
  const filtered = Boolean(place || medicine);

  return (
    <main>
      <div className="page-head">
        <h1>Stock alerts</h1>
        <p>
          Medicines at risk across {overview.locations} facilities
          {overview.latestRun && <>, based on reports up to {monthYear(overview.latestRun.data_until)}</>}. Most urgent first.
        </p>
      </div>

      {overview.syntheticData && (
        <p className="demo-banner">
          <Info size={16} aria-hidden />
          Demonstration data from a fictional sub-county. No real facilities or patients.
        </p>
      )}

      <nav aria-label="Filter by alert type">
        <ul className="summary">
          {STATUS_ORDER.map((s) => {
            const Icon = ICONS[s];
            return (
              <li key={s}>
                <Link
                  href={href({ status: status === s ? undefined : s })}
                  className={`panel s-${s}`}
                  aria-current={status === s ? 'page' : undefined}
                >
                  <span className="icon">
                    <Icon size={20} aria-hidden />
                  </span>
                  <span>
                    <span className="count num">{list.counts[s]}</span>
                    <span className="label">{STATUS[s].label}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="panel" aria-label="Alerts">
        <div className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
          <form className="filters" method="get" action="/">
            {status && <input type="hidden" name="status" value={status} />}
            <label className="field">
              <span>Facility</span>
              <select name="location_id" defaultValue={locationId}>
                <option value="">All facilities</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Medicine</span>
              <select name="item_id" defaultValue={itemId}>
                <option value="">All medicines</option>
                {medicines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="submit">
              Apply filters
            </button>
            {filtered && (
              <Link className="btn btn-ghost" href={href({ location_id: undefined, item_id: undefined })}>
                Clear
              </Link>
            )}
          </form>
        </div>

        <div className="table-meta" aria-live="polite">
          <span>
            {list.total} alert{list.total === 1 ? '' : 's'}
            {place && <> at {place.name}</>}
            {medicine && <> for {medicine.name}</>}
            {status && <>: {STATUS[status].label.toLowerCase()}</>}
          </span>
          {status && <Link href={href({ status: undefined })}>Show all types</Link>}
        </div>

        {list.items.length === 0 ? (
          <div className="empty">
            {filtered || status
              ? 'Nothing needs attention for this selection. Try another facility or medicine.'
              : 'No alerts in the latest forecast.'}
          </div>
        ) : (
          <>
            <div className="thead" aria-hidden="true">
              <span>Medicine</span>
              <span>Facility</span>
              <span>Status</span>
              <span>Risk</span>
              <span>Main reason</span>
              <span />
            </div>
            <ol className="rows">
              {list.items.map((a) => (
                <li key={a.id}>
                  <Link href={`/alerts/${a.id}`} className={`trow s-${a.status}`}>
                    <span className="med">{a.item_name}</span>
                    <span className="fac">{a.location_name}</span>
                    <span className="status">
                      <span className="badge">{STATUS[a.status].short}</span>
                    </span>
                    <span className="risk num">
                      {a.status === 'out_now' ? (
                        <span style={{ color: 'var(--red)' }}>Empty shelf</span>
                      ) : (
                        <>
                          <span>
                            <span className="cell-label">{a.status === 'expiry' ? 'Share at risk ' : 'Chance '}</span>
                            {pct(a.risk)}
                          </span>
                          <span className="meter" aria-hidden>
                            <i style={{ width: pct(a.risk) }} />
                          </span>
                        </>
                      )}
                    </span>
                    <span className="reason">
                      {a.headline}
                      {a.confidence === 'low' && <span className="flag">Patchy reporting</span>}
                    </span>
                    <ChevronRight className="go" size={18} aria-hidden />
                  </Link>
                </li>
              ))}
            </ol>
          </>
        )}

        {list.total > list.items.length && (
          <div className="more">
            <Link href={href({ limit: String(limit + PAGE) })} scroll={false}>
              Show {Math.min(PAGE, list.total - list.items.length)} more
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
