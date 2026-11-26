import Link from "next/link";
import { PERFORMANCE_RANGES, parseRange, performanceView, pnlSankey, positionsPnl } from "@trader/core";
import { PerformanceChart } from "@/components/performance-chart";
import { RangePicker } from "@/components/range-picker";
import { SankeyChart } from "@/components/sankey";
import { Card, PhoneRow, RowsOnPhone, Signed, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatPct, formatPts, formatSignedUsd, formatUsd, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Performance (SPEC-dashboard Amendment 3): dollars and percent over every range, against VTI, and which bets made or lost the money. */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { db } = await signedIn();
  const v = await performanceView(db, parseRange((await searchParams).range, PERFORMANCE_RANGES, "all"));
  const chosen = v.ranges.find((r) => r.range === v.range);
  const pnl = chosen?.since && chosen.through ? await positionsPnl(db, chosen.since, chosen.through) : null;
  const parts =
    pnl?.status === "ok"
      ? [...pnl.positions.map((p) => ({ name: p.symbol, value: p.pnl })), { name: "After-close pricing", value: pnl.afterClosePricing }, { name: "Dividends, fees and rounding", value: pnl.cashAndOther }]
      : [];
  const available = v.ranges.filter((r) => r.available);

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card title="Performance">
        <RangePicker options={v.ranges} selected={v.range} path="/performance" />
        {chosen?.pnl ? (
          <div className="mt-3">
            <p className="text-3xl font-semibold">
              <Signed value={chosen.pnl}>{formatSignedUsd(chosen.pnl)}</Signed>
              {chosen.returnPct && <span className="ml-2 text-lg text-[var(--muted)]">{formatPct(chosen.returnPct)}</span>}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {shortDate(chosen.since!)} to {shortDate(chosen.through!)} close
              {chosen.vtiPct && <> · VTI {formatPct(chosen.vtiPct)}</>}
              {chosen.gapUsd && (
                <>
                  {" "}
                  · {formatSignedUsd(chosen.gapUsd)} {chosen.gapUsd.startsWith("-") ? "behind" : "ahead of"} the same money in VTI
                </>
              )}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--muted)]">The figures start after two sessions.</p>
        )}
        <div className="mt-3">
          <PerformanceChart points={v.series.points} />
        </div>
      </Card>

      <Card title="Every range">
        <TableOnWide>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="py-1 pr-3 font-medium">Range</th>
                <th className="py-1 pr-3 text-right font-medium">Made or lost</th>
                <th className="py-1 pr-3 text-right font-medium">Return</th>
                <th className="py-1 pr-3 text-right font-medium">VTI</th>
                <th className="py-1 pr-3 text-right font-medium">vs VTI</th>
                <th className="py-1 text-right font-medium">vs VTI ($)</th>
              </tr>
            </thead>
            <tbody>
              {available.map((r) => (
                <tr key={r.range} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-3">
                    <Link href={`/performance?range=${r.range}`}>{r.label}</Link>
                  </td>
                  <td className="py-1.5 pr-3 text-right">{r.pnl ? <Signed value={r.pnl}>{formatSignedUsd(r.pnl)}</Signed> : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.returnPct ? formatPct(r.returnPct) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.vtiPct ? formatPct(r.vtiPct) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.gapPts ? formatPts(r.gapPts) : "—"}</td>
                  <td className="py-1.5 text-right">{r.gapUsd ? formatSignedUsd(r.gapUsd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableOnWide>
        <RowsOnPhone>
          {available.map((r) => (
            <PhoneRow
              key={r.range}
              title={<Link href={`/performance?range=${r.range}`}>{r.label}</Link>}
              value={r.pnl ? <Signed value={r.pnl}>{formatSignedUsd(r.pnl)}</Signed> : "—"}
              detail={r.returnPct ? `${formatPct(r.returnPct)} · VTI ${r.vtiPct ? formatPct(r.vtiPct) : "—"}` : undefined}
              secondary={r.gapUsd ? `${formatSignedUsd(r.gapUsd)} vs VTI` : undefined}
            />
          ))}
        </RowsOnPhone>
        {v.ranges.some((r) => !r.available) && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Not yet: {v.ranges.filter((r) => !r.available).map((r) => r.label).join(", ")} ({v.ranges.find((r) => !r.available)?.reason}).
          </p>
        )}
      </Card>

      <Card title={`Which bets made or lost the money${chosen ? ` · ${chosen.label}` : ""}`}>
        {pnl?.status === "ok" ? (
          <>
            <ul className="mb-3 divide-y divide-[var(--border)] text-sm">
              {pnl.positions.map((p) => (
                <li key={p.symbol} className="flex justify-between gap-3 py-1.5">
                  <span>{p.symbol}</span>
                  <Signed value={p.pnl}>{formatSignedUsd(p.pnl)}</Signed>
                </li>
              ))}
              <li className="flex justify-between gap-3 py-1.5 text-[var(--muted)]">
                <span>After-close pricing</span>
                <span>{formatSignedUsd(pnl.afterClosePricing)}</span>
              </li>
              <li className="flex justify-between gap-3 py-1.5 text-[var(--muted)]">
                <span>Dividends, fees and rounding</span>
                <span>{formatSignedUsd(pnl.cashAndOther)}</span>
              </li>
              <li className="flex justify-between gap-3 py-1.5 font-medium">
                <span>Total</span>
                <span>{formatSignedUsd(pnl.total)}</span>
              </li>
            </ul>
            <SankeyChart data={pnlSankey({ parts, cap: 8 })} unit="usd" label={`Each bet's gain or loss over the range, netting to ${formatUsd(pnl.total)}`} />
          </>
        ) : (
          <p className="text-sm text-[var(--muted)]">{pnl?.status === "unavailable" ? `Not available: ${pnl.reason}.` : "Pick a range to see it."}</p>
        )}
      </Card>
    </div>
  );
}
