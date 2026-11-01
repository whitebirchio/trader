"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PerformancePoint } from "@trader/core";

/**
 * Trader vs VTI, both rebased to 100 at the first snapshot: one axis, two
 * series (validated slots 1–2), a legend plus direct end labels, a crosshair
 * tooltip, and a table view. Numbers are converted here for drawing only.
 */
type LabelProps = { index?: number; x?: number | string; y?: number | string };

/** A direct label at a line's last point only. */
const endLabel = (text: string, lastIndex: number) =>
  function EndLabel(p: LabelProps) {
    return p.index === lastIndex ? <text x={Number(p.x ?? 0) + 6} y={Number(p.y ?? 0) + 4} fill="var(--text)" fontSize={11}>{text}</text> : <g />;
  };

export function PerformanceChart({ points }: { points: PerformancePoint[] }) {
  const data = points.map((p) => ({ date: p.date, trader: Number(p.portfolio), vti: p.benchmark === null ? null : Number(p.benchmark) }));
  const last = points.at(-1);
  if (points.length < 2) {
    return <p className="text-sm text-[var(--muted)]">The chart starts after two trading days of snapshots (written after each close).</p>;
  }
  return (
    <figure>
      <div className="h-64 w-full" role="img" aria-label={`Trader ${last?.portfolio} vs VTI ${last?.benchmark ?? "n/a"}, both from 100`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={32} />
            <YAxis domain={["auto", "auto"]} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
            <Tooltip
              cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12 }}
              formatter={(v, name) => [typeof v === "number" ? v.toFixed(2) : "—", name === "trader" ? "Trader" : "VTI"]}
            />
            <Legend formatter={(v) => <span style={{ color: "var(--text)", fontSize: 12 }}>{v === "trader" ? "Trader" : "VTI"}</span>} />
            <Line dataKey="trader" stroke="var(--portfolio)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false}
              label={endLabel("Trader", data.length - 1)} />
            <Line dataKey="vti" stroke="var(--benchmark)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} connectNulls
              label={endLabel("VTI", data.length - 1)} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">Table view</summary>
        <table className="mt-2 w-full">
          <thead className="text-left text-[var(--muted)]">
            <tr><th className="py-1">Date</th><th className="text-right">Trader</th><th className="text-right">VTI</th></tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date} className="border-t border-[var(--border)]">
                <td className="py-1">{p.date}</td><td className="text-right">{p.portfolio}</td><td className="text-right">{p.benchmark ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
