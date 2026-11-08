"use client";

import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { thesisView } from "@trader/core";

/**
 * One thesis's daily close (validated slot 1) with its cost and stop as
 * direct-labeled muted lines, its fills as shape-coded markers (▲ buy, ▼ sell)
 * and its evidence dates as recessive guides; a crosshair tooltip and a table
 * view. Numbers are converted here for drawing only.
 */
type Chart = NonNullable<Awaited<ReturnType<typeof thesisView>>>["chart"];
type Fill = Chart["fills"][number];
type Evidence = Chart["evidence"][number];

/** A triangle marker, at least 8px, ringed with the surface so it separates from the line. */
const triangle = (up: boolean) =>
  function Marker(p: { cx?: number; cy?: number }) {
    const x = p.cx ?? 0;
    const y = p.cy ?? 0;
    const d = up ? `M${x},${y - 6} L${x + 6},${y + 5} L${x - 6},${y + 5} Z` : `M${x},${y + 6} L${x + 6},${y - 5} L${x - 6},${y - 5} Z`;
    return <path d={d} fill="var(--text)" stroke="var(--surface)" strokeWidth={2} />;
  };

const usd = (v: number) => `$${v.toFixed(2)}`;

/** A round axis step (1, 2 or 5 × a power of ten) giving about four intervals over `span`. */
function niceStep(span: number): number {
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
}

export function ThesisChart({ chart }: { chart: Chart }) {
  const data = chart.closes.map((c) => ({ date: c.date, close: Number(c.close) }));
  if (data.length < 2) {
    return <p className="text-sm text-[var(--muted)]">The chart starts once two daily closes are recorded (after each close).</p>;
  }
  const dates = data.map((d) => d.date);
  // Markers sit on chart dates: a fill or evidence date with no close moves to the next session shown; one before the range isn't drawn.
  const onChart = (date: string) => (date < dates[0]! ? null : (dates.find((d) => d >= date) ?? null));
  const fillsOn = new Map<string, Fill[]>();
  for (const f of chart.fills) {
    const d = onChart(f.date);
    if (d) fillsOn.set(d, [...(fillsOn.get(d) ?? []), f]);
  }
  const evidenceOn = new Map<string, Evidence[]>();
  for (const e of chart.evidence) {
    const d = onChart(e.date);
    if (d) evidenceOn.set(d, [...(evidenceOn.get(d) ?? []), e]);
  }
  const levels = [...data.map((d) => d.close), ...chart.fills.map((f) => Number(f.price)), ...(chart.cost ? [Number(chart.cost)] : []), ...(chart.stopPrice ? [Number(chart.stopPrice)] : [])];
  // Round the axis out to even steps, so its labels are round prices.
  const step = niceStep(Math.max(...levels) - Math.min(...levels) || Math.max(...levels) * 0.1 || 1);
  const domain: [number, number] = [Math.max(0, Math.floor(Math.min(...levels) / step) * step), Math.ceil(Math.max(...levels) / step) * step];
  const ticks = Array.from({ length: Math.round((domain[1] - domain[0]) / step) + 1 }, (_, i) => domain[0] + i * step);
  const last = data.at(-1)!;

  return (
    <figure>
      <div className="h-64 w-full" role="img" aria-label={`Daily close from ${data[0]!.date} to ${last.date}, last ${usd(last.close)}${chart.cost ? `, cost ${usd(Number(chart.cost))}` : ""}${chart.stopPrice ? `, stop ${usd(Number(chart.stopPrice))}` : ""}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 104, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={32} />
            <YAxis domain={domain} ticks={ticks} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => `$${v.toFixed(step < 1 ? 2 : 0)}`} />
            {[...evidenceOn.keys()].map((d) => (
              <ReferenceLine key={`e-${d}`} x={d} stroke="var(--muted)" strokeOpacity={0.5} strokeDasharray="2 3" />
            ))}
            {chart.cost && (
              <ReferenceLine y={Number(chart.cost)} stroke="var(--muted)" strokeWidth={1.5}
                label={{ value: `cost ${usd(Number(chart.cost))}`, position: "right", fill: "var(--text)", fontSize: 11 }} />
            )}
            {chart.stopPrice && (
              <ReferenceLine y={Number(chart.stopPrice)} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="6 4"
                label={{ value: `stop ${usd(Number(chart.stopPrice))}`, position: "right", fill: "var(--text)", fontSize: 11 }} />
            )}
            <Tooltip
              cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
              content={({ active, label }) => {
                if (!active || typeof label !== "string") return null;
                const close = data.find((d) => d.date === label)?.close;
                return (
                  <div className="max-w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)]">
                    <div className="font-medium">{label}</div>
                    {close !== undefined && <div>Close {usd(close)}</div>}
                    {(fillsOn.get(label) ?? []).map((f) => (
                      <div key={f.at}>{f.side === "buy" ? "▲ Bought" : "▼ Sold"} {f.qty} at ${f.price}</div>
                    ))}
                    {(evidenceOn.get(label) ?? []).map((e) => (
                      <div key={e.summary} className="text-[var(--muted)]">{e.kind} ({e.date}): {e.summary}</div>
                    ))}
                  </div>
                );
              }}
            />
            <Line dataKey="close" stroke="var(--portfolio)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
            {[...fillsOn.entries()].flatMap(([d, fs]) =>
              fs.map((f) => <ReferenceDot key={f.at} x={d} y={Number(f.price)} r={6} shape={triangle(f.side === "buy")} />),
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 text-xs text-[var(--muted)]">
        ▲ buy · ▼ sell · solid line: average cost{chart.stopPrice ? " · dashed line: stop" : ""}{evidenceOn.size ? " · dotted guides: evidence dates" : ""}. Closes are adjusted for dividends and splits; fills and cost are actual prices.
      </figcaption>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">Table view</summary>
        <table className="mt-2 w-full">
          <thead className="text-left text-[var(--muted)]">
            <tr><th className="py-1">Date</th><th className="text-right">Close</th><th className="pl-3">Fills and evidence</th></tr>
          </thead>
          <tbody>
            {chart.closes.map((c) => (
              <tr key={c.date} className="border-t border-[var(--border)] align-top">
                <td className="py-1">{c.date}</td>
                <td className="text-right">${c.close}</td>
                <td className="pl-3">
                  {[
                    ...(fillsOn.get(c.date) ?? []).map((f) => `${f.side === "buy" ? "Bought" : "Sold"} ${f.qty} at $${f.price}`),
                    ...(evidenceOn.get(c.date) ?? []).map((e) => `${e.kind}: ${e.summary}`),
                  ].join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
