import Link from 'next/link';
import { ArrowRight, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { STATUS, kes, num, qty, urgencyStatus } from '@/lib/format';

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function TransfersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const locationId = (Array.isArray(sp.location_id) ? sp.location_id[0] : sp.location_id) ?? '';
  const q = new URLSearchParams();
  if (locationId) q.set('location_id', locationId);
  const [plan, places] = await Promise.all([api.transfers(q), api.locations()]);
  const s = plan.summary;
  const place = places.find((p) => String(p.id) === locationId);

  return (
    <main>
      <div className="page-head">
        <h1>Transfers</h1>
        <p>Stock that can move between facilities now, grouped into trips. Most urgent first.</p>
      </div>

      {!s ? (
        <div className="panel empty">No transfer plan yet. Run the optimiser to create one.</div>
      ) : (
        <>
          <dl className="stats">
            <div className="panel stat">
              <dt>Trips suggested</dt>
              <dd className="num">
                {s.trips}
                <small>{s.transfers} medicine lines</small>
              </dd>
            </div>
            <div className="panel stat">
              <dt>Out-of-stock lines helped</dt>
              <dd className="num">
                {s.out_of_stock_lines_helped_by_transfer} of {s.out_of_stock_lines}
                <small>without waiting for a delivery</small>
              </dd>
            </div>
            <div className="panel stat">
              <dt>Stock value moved</dt>
              <dd className="num">
                {kes(s.value_moved_kes)}
                <small>
                  saves about {kes(s.reorder_cost_without_transfers_kes - s.reorder_cost_total_kes)} in orders
                </small>
              </dd>
            </div>
            <div className="panel stat">
              <dt>Near-expiry stock put to use</dt>
              <dd className="num">
                {kes(s.expiring_value_saved_kes)}
                <small>{num(s.expiring_units_saved)} units that would have expired</small>
              </dd>
            </div>
          </dl>

          <section className="panel" aria-label="Trips">
            <div className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
              <form className="filters" method="get" action="/transfers">
                <label className="field">
                  <span>Facility (sending or receiving)</span>
                  <select name="location_id" defaultValue={locationId}>
                    <option value="">All facilities</option>
                    {places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn btn-primary" type="submit">
                  Apply filter
                </button>
                {place && (
                  <Link className="btn btn-ghost" href="/transfers">
                    Clear
                  </Link>
                )}
              </form>
            </div>
            <div className="table-meta">
              <span>
                {plan.trips.length} trip{plan.trips.length === 1 ? '' : 's'}
                {place && <> involving {place.name}</>}
              </span>
            </div>
            {plan.trips.length === 0 ? (
              <div className="empty">No transfers involve this facility. Its needs are covered by reorders.</div>
            ) : (
              <ol className="trips">
                {plan.trips.map((t) => (
                  <li key={`${t.from_id}-${t.to_id}`} className={`trip s-${urgencyStatus(t.most_urgent_days)}`}>
                    <p className="trip-route">
                      <Truck size={18} aria-hidden />
                      <span>{t.from_name}</span>
                      <ArrowRight size={16} aria-hidden />
                      <span>{t.to_name}</span>
                      <span className="badge">{STATUS[urgencyStatus(t.most_urgent_days)].short}</span>
                      <span className="meta num">
                        about {Math.round(t.distance_km)} km by road, {kes(t.value_kes)}
                      </span>
                    </p>
                    <ul className="trip-lines">
                      {t.lines.map((l) => (
                        <li key={l.id}>
                          <span>
                            {l.alert_id ? <Link href={`/alerts/${l.alert_id}`}>{l.item_name}</Link> : l.item_name}
                            {l.ven === 'V' && (
                              <span className="ven ven-V" style={{ marginLeft: '0.5rem' }}>
                                Vital
                              </span>
                            )}
                          </span>
                          <span className="qty num">
                            {qty(l.quantity, l.unit)}
                          </span>
                          <span className="note">{l.reason.split('. ').slice(1).join('. ')}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </main>
  );
}
