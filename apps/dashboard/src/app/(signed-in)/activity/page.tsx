import Link from "next/link";
import { activityView } from "@trader/core";
import { Badge, Card, PhoneRow, RowsOnPhone, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatEt, formatQty, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

const RANGES = [7, 14, 30, 90];
const LABELS: Record<string, string> = {
  "order.submitted": "Order submitted",
  "order.filled": "Filled",
  "order.partially_filled": "Partially filled",
  "order.canceled": "Order canceled",
  "order.rejected": "Order rejected",
  "order.external": "Order placed outside Trader",
  "risk.order_clipped": "Risk clipped an order",
  "risk.order_rejected": "Risk rejected an order",
  "risk.halted": "Trading halted",
  "risk.kill_switch_on": "Kill switch on",
  "risk.resumed": "Resumed by owner",
  "risk.buys_paused": "Buys paused for the day",
  "strategy.activated": "Strategy activated",
  "strategy.rejected": "Strategy rejected",
  "thesis.stopped_out": "Thesis stopped out",
  "thesis.stale": "Thesis went stale",
  "capital.deposit_received": "Deposit received",
  "capital.transfer_reversed": "Transfer reversed",
  "capital.transfer_canceled": "Transfer canceled",
  "capital.unplanned_outflow": "Money out without a request",
  "capital.withdrawal_requested": "Withdrawal requested",
  "capital.fund_now": "Withdrawal: fund now",
  "capital.withdrawal_cancelled": "Withdrawal cancelled",
  "capital.command_rejected": "Withdrawal command rejected",
  "capital.funding_planned": "Withdrawal funding planned",
  "capital.withdrawal_settling": "Withdrawal cash raised",
  "capital.withdrawal_ready": "Withdrawal ready",
  "capital.withdrawal_partial": "Part of a withdrawal taken",
  "capital.withdrawal_completed": "Withdrawal complete",
};

type Trade = { proposal?: { side?: string; symbol?: string; notional?: string | null; qty?: string | null; sleeve?: string }; reason?: string };

function eventDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["reason", "reasons", "summary", "errors"]) {
    const v = p[key];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join("; ");
  }
  return null;
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { db } = await signedIn();
  const requested = Number((await searchParams).days ?? 14);
  const days = RANGES.includes(requested) ? requested : 14;
  const a = await activityView(db, new Date(), days);
  return (
    <div className="grid grid-cols-1 gap-4">
      <nav aria-label="Period" className="flex flex-wrap gap-1 text-sm">
        {RANGES.map((d) => (
          <Link
            key={d}
            href={`/activity?days=${d}`}
            aria-current={d === days ? "true" : undefined}
            className={`flex min-h-11 items-center rounded-md px-3 sm:min-h-0 sm:px-2.5 sm:py-1 ${d === days ? "bg-[var(--text)] text-[var(--background)]" : "hover:bg-[var(--border)]"}`}
          >
            {d} days
          </Link>
        ))}
      </nav>

      <Card title="Rebalance steps">
        {a.rebalanceSteps.length === 0 && <p className="text-sm text-[var(--muted)]">No rebalance steps in this period.</p>}
        <ul className="grid grid-cols-1 gap-3">
          {a.rebalanceSteps.map((s) => (
            <li key={s.at} className="text-sm">
              <div className="font-medium">{formatEt(s.at)} · {s.phase} · v{s.strategyVersion}</div>
              <ul className="mt-1 grid gap-0.5">
                {(s.trades as Trade[]).map((t, i) => (
                  <li key={i}>
                    <span className="font-medium">{t.proposal?.side} {t.proposal?.symbol}</span>{" "}
                    {t.proposal?.notional ? formatUsd(t.proposal.notional) : t.proposal?.qty ? `${formatQty(t.proposal.qty)} sh` : ""}
                    {t.reason && <span className="text-[var(--muted)]">: {t.reason}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Orders">
        {a.orders.length === 0 && <p className="text-sm text-[var(--muted)]">No orders in this period.</p>}
        <RowsOnPhone>
          {a.orders.map((o) => (
            <PhoneRow
              key={`${o.at}-${o.symbol}-${o.side}`}
              title={`${o.side} ${o.symbol}`}
              value={o.notional ? formatUsd(o.notional) : o.qty ? `${formatQty(o.qty)} sh` : ""}
              detail={formatEt(o.at)}
              secondary={`${o.status}${o.filledAvgPrice ? ` @ ${formatUsd(o.filledAvgPrice)}` : ""}`}
            />
          ))}
        </RowsOnPhone>
        <TableOnWide>
          <table className="w-full min-w-[32rem] text-sm">
            <tbody>
              {a.orders.map((o) => (
                <tr key={`${o.at}-${o.symbol}-${o.side}`} className="border-t border-[var(--border)] first:border-0">
                  <td className="py-1.5 text-[var(--muted)]">{formatEt(o.at)}</td>
                  <td className="font-medium">{o.side} {o.symbol}</td>
                  <td className="text-right">{o.notional ? formatUsd(o.notional) : o.qty ? `${formatQty(o.qty)} sh` : ""}</td>
                  <td className="text-right">{o.status}{o.filledAvgPrice ? ` @ ${formatUsd(o.filledAvgPrice)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableOnWide>
      </Card>

      <Card title="Events">
        {a.events.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing in this period.</p>}
        <ul className="grid gap-2 text-sm">
          {a.events.map((e, i) => {
            const detail = eventDetail(e.payload);
            return (
              <li key={i} className="flex gap-3">
                <span className="w-24 shrink-0 text-[var(--muted)]">{formatEt(e.at)}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {LABELS[e.kind] ?? e.kind} {e.subject && <span className="font-medium">{e.subject}</span>} <Badge>{e.actor}</Badge>
                  {detail && <span className="line-clamp-2 text-[var(--muted)]">{detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
