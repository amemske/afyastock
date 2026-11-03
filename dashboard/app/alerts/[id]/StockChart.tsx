'use client';

import { Bar, CartesianGrid, Cell, ComposedChart, ErrorBar, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { monthShort, monthYear, num } from '@/lib/format';
import type { AlertDetail } from '@/lib/api';

interface Props {
  history: AlertDetail['history'];
  forecast: AlertDetail['forecast'];
  unit: string;
}

interface Point {
  period: string;
  used?: number;
  stock?: number;
  forecast?: number;
  range?: [number, number];
  imputed?: boolean;
  empty?: boolean;
}

const MONTHS_SHOWN = 24;

export default function StockChart({ history, forecast, unit }: Props) {
  const data: Point[] = [
    ...history.slice(-MONTHS_SHOWN).map((h) => ({ period: h.period, used: h.used, stock: h.closing, imputed: h.imputed, empty: h.empty_shelf })),
    ...forecast.map((f) => ({
      period: f.period,
      forecast: f.predicted,
      range: [f.predicted - f.lower, f.upper - f.predicted] as [number, number],
    })),
  ];

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }} barCategoryGap="12%" barGap={0}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="period"
              tickFormatter={monthShort}
              interval="preserveStartEnd"
              minTickGap={24}
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border)' }}
            />
            <YAxis
              width={48}
              tickFormatter={(v: number) => num(v)}
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              labelFormatter={(l) => monthYear(String(l))}
              formatter={(value, name) => [`${num(Number(value))} ${unit}s`, String(name)]}
              contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <Bar dataKey="used" name="Used" isAnimationActive={false}>
              {data.map((d) => (
                <Cell
                  key={d.period}
                  fill={d.empty ? 'var(--red)' : 'var(--chart-use)'}
                  fillOpacity={d.imputed ? 0.35 : 1}
                />
              ))}
            </Bar>
            <Bar
              dataKey="forecast"
              name="Forecast use"
              fill="var(--amber)"
              fillOpacity={0.25}
              stroke="var(--amber)"
              strokeDasharray="4 3"
              isAnimationActive={false}
            >
              <ErrorBar dataKey="range" stroke="var(--amber)" width={6} />
            </Bar>
            <Line
              dataKey="stock"
              name="On the shelf at month end"
              stroke="var(--chart-stock)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="chart-key">
        <li>
          <span aria-hidden style={{ background: 'var(--chart-use)' }} />
          Used each month
        </li>
        <li>
          <span aria-hidden style={{ background: 'var(--red)' }} />
          Month ended with an empty shelf
        </li>
        <li>
          <span aria-hidden style={{ background: 'var(--chart-use)', opacity: 0.35 }} />
          Estimated (report missing)
        </li>
        <li>
          <span aria-hidden style={{ border: '2px dashed var(--amber)' }} />
          Forecast, with likely range
        </li>
        <li>
          <span aria-hidden style={{ background: 'var(--chart-stock)', height: 3, verticalAlign: '0.2rem' }} />
          On the shelf at month end
        </li>
      </ul>
      <figcaption className="forecast-line">
        Red months understate real need: when the shelf is empty, patients who came could not be given the medicine.
      </figcaption>
    </figure>
  );
}
