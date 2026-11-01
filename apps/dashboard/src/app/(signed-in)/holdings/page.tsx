import { holdingsView } from "@trader/core";
import { HoldingsTable } from "@/components/holdings-table";
import { Card } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HoldingsPage() {
  const { db } = await signedIn();
  const h = await holdingsView(db, new Date());
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">Equity {formatUsd(h.equity)}. Weights are of equity; gains are against average cost.</p>
      <Card title="Conviction · Claude's theses"><HoldingsTable rows={h.conviction} conviction /></Card>
      <Card title="Systematic · momentum and trend (idle money in VTI)"><HoldingsTable rows={h.systematic} conviction={false} /></Card>
      {h.washSaleWindows.length > 0 && (
        <Card title="Open wash-sale windows">
          <ul className="grid gap-1 text-sm">
            {h.washSaleWindows.map((w) => (
              <li key={`${w.symbol}-${w.soldAt}`}>
                {w.symbol}: sold at a loss of {formatUsd(w.loss)} on {w.soldAt.slice(0, 10)}; buying back before {w.windowEnds} disallows the loss.
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
