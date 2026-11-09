import Link from "next/link";
import type { HoldingRow } from "@trader/core";
import { Change, PhoneRow, RowsOnPhone, TableOnWide } from "@/components/ui";
import { formatPct, formatQty, formatUsd } from "@/lib/format";

export function HoldingsTable({ rows, conviction }: { rows: HoldingRow[]; conviction: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-[var(--muted)]">Nothing held in this sleeve.</p>;
  const symbolCell = (r: HoldingRow) => (
    <>
      {r.thesis ? <Link href={`/theses/${r.thesis.id}`} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{r.symbol}</Link> : r.symbol}
      {r.thesis && r.thesis.state !== "active" && <span className="ml-2 text-xs text-[var(--warn)]">▲ {r.thesis.state}</span>}
    </>
  );
  const stop = (r: HoldingRow) =>
    r.thesis?.stopPrice ? `stop ${formatUsd(r.thesis.stopPrice)} (${r.thesis.toStopPct ? formatPct(r.thesis.toStopPct, 1) : "—"} away)` : null;
  return (
    <>
    <RowsOnPhone>
      {rows.map((r) => {
        const stopLine = conviction ? stop(r) : null;
        return (
          <PhoneRow
            key={r.symbol}
            title={symbolCell(r)}
            value={formatUsd(r.marketValue)}
            detail={`${formatPct(r.weightPct, 1, false)} of equity${conviction && r.thesis ? ` · target ${formatPct(r.thesis.targetPct, 1, false)}` : ""}`}
            secondary={<Change pct={r.gainPct} />}
            foot={[`${formatQty(r.qty)} @ ${formatUsd(r.price)}`, ...(stopLine ? [stopLine] : [])].join(" · ")}
          />
        );
      })}
    </RowsOnPhone>
    <TableOnWide>
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="text-left text-xs text-[var(--muted)]">
          <tr>
            <th className="py-1.5">Symbol</th>
            <th className="text-right">Value</th>
            <th className="text-right">Weight</th>
            {conviction && <th className="text-right">Target</th>}
            <th className="text-right">Gain</th>
            <th className="text-right">Qty @ price</th>
            {conviction && <th className="text-right">Stop</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-t border-[var(--border)]">
              <td className="py-2 font-medium">{symbolCell(r)}</td>
              <td className="text-right">{formatUsd(r.marketValue)}</td>
              <td className="text-right">{formatPct(r.weightPct, 1, false)}</td>
              {conviction && <td className="text-right">{r.thesis ? formatPct(r.thesis.targetPct, 1, false) : "—"}</td>}
              <td className="text-right"><Change pct={r.gainPct} /></td>
              <td className="text-right text-[var(--muted)]">{formatQty(r.qty)} @ {formatUsd(r.price)}</td>
              {conviction && (
                <td className="text-right">
                  {r.thesis?.stopPrice ? (
                    <span title={`Stop-loss ${r.thesis.stopLossPct}% below average cost`}>
                      {formatUsd(r.thesis.stopPrice)} <span className="text-[var(--muted)]">({r.thesis.toStopPct ? formatPct(r.thesis.toStopPct, 1) : "—"} away)</span>
                    </span>
                  ) : "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableOnWide>
    </>
  );
}
