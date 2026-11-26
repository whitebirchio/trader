"use client";

import { useEffect, useRef, useState } from "react";
import { ResponsiveContainer, Sankey, Tooltip } from "recharts";
import type { SankeyData } from "@trader/core";
import { formatSignedUsd, formatUsd } from "@/lib/format";
import { useNarrow } from "@/lib/use-narrow";

/**
 * One of the dashboard's Sankey diagrams (SPEC-dashboard Amendment 3), drawn
 * from core's nodes and links: core builds and reconciles them, this only
 * draws. Values become numbers here for drawing only. Every flow is also in
 * the table view, so nothing depends on hovering or on color.
 */
type NodeProps = { x: number; y: number; width: number; height: number; payload: { name: string; value: number } };

export function SankeyChart({ data, unit, label }: { data: SankeyData; unit: "usd" | "count"; label: string }) {
  const narrow = useNarrow();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!wrap.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  if (data.links.length === 0) return <p className="text-sm text-[var(--muted)]">Nothing to show yet.</p>;

  const show = (v: number | string) => (unit === "usd" ? formatUsd(String(v)) : String(v));
  const chart = { nodes: data.nodes.map((n) => ({ name: n.name })), links: data.links.map((l) => ({ source: l.source, target: l.target, value: Number(l.value) })) };
  const Node = (p: NodeProps) => {
    // Labels sit outside the node, toward the middle, so the first and last columns stay readable.
    const right = p.x < width / 2;
    return (
      <g>
        <rect x={p.x} y={p.y} width={p.width} height={p.height} fill="var(--portfolio)" rx={2} />
        <text x={right ? p.x + p.width + 6 : p.x - 6} y={p.y + p.height / 2} textAnchor={right ? "start" : "end"} dominantBaseline="middle" fill="var(--text)" fontSize={narrow ? 10 : 12}>
          {p.payload.name}
          <tspan fill="var(--muted)"> {show(p.payload.value)}</tspan>
        </text>
      </g>
    );
  };
  return (
    <figure>
      <div ref={wrap} className="h-72 w-full sm:h-80" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey data={chart} node={Node as never} nodePadding={narrow ? 14 : 22} nodeWidth={8} margin={{ top: 8, bottom: 8, left: 4, right: 4 }} link={{ stroke: "var(--border)", strokeOpacity: 0.9 }}>
            <Tooltip formatter={(v) => show(Number(v))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }} />
          </Sankey>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-[var(--muted)] sm:min-h-0">Table view</summary>
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {data.links.map((l, i) => (
            <li key={i} className="flex justify-between gap-3 py-1.5">
              <span>
                {data.nodes[l.source]?.name} → {data.nodes[l.target]?.name}
              </span>
              <span className="shrink-0">
                {show(l.value)}
                {l.usd !== undefined && <span className="text-[var(--muted)]"> · {formatSignedUsd(l.usd)}</span>}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}
