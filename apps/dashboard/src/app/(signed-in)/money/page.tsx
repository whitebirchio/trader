import { moneyView } from "@trader/core";
import { Badge, Card, PhoneRow, RowsOnPhone, StatTile, Status, TableOnWide } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatEt, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEPS = [
  ["planning", "Planning", "Claude chooses what to sell (or the fallback does)"],
  ["funding", "Selling", "The rebalance sells to raise the cash"],
  ["settling", "Settling", "Sale proceeds settle the next trading day"],
  ["ready", "Ready", "Withdraw it in Alpaca"],
] as const;

const EVENT_LABELS: Record<string, string> = {
  "capital.withdrawal_requested": "Requested",
  "capital.fund_now": "Fund now",
  "capital.funding_planned": "Funding planned",
  "capital.withdrawal_settling": "Cash raised, settling",
  "capital.withdrawal_ready": "Ready to withdraw",
  "capital.withdrawal_partial": "Part withdrawn",
};

const KIND_LABELS: Record<string, string> = { deposit: "Deposit", withdrawal: "Withdrawal", reversal: "Reversal" };
const amountLabel = (amount: string) => (amount === "all" ? "Everything" : formatUsd(amount));

const SENT: Record<string, string> = {
  request: "Withdrawal requested.",
  cancel: "Cancel sent.",
  fund_now: "Fund now sent.",
};

/** A GET to the confirmation page: nothing changes until you confirm there. */
function CommandLink({ kind, children }: { kind: "cancel" | "fund_now"; children: React.ReactNode }) {
  return (
    <form method="get" action="/money/confirm">
      <input type="hidden" name="kind" value={kind} />
      <button type="submit" className="min-h-11 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--border)] sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{children}</button>
    </form>
  );
}

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { db } = await signedIn();
  const sent = SENT[(await searchParams).sent ?? ""];
  const m = await moneyView(db, new Date());
  const w = m.withdrawal;
  const step = w ? STEPS.findIndex(([s]) => s === w.status) : -1;
  return (
    <div className="grid grid-cols-1 gap-4">
      {sent && (
        <div role="status" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm">
          <Status level="good">{sent}</Status> The engine picks it up within 15 minutes and emails you; until then it shows as waiting under Recent commands.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Put in" value={m.summary ? formatUsd(m.summary.contributed) : "—"} detail="Deposits − withdrawals" />
        <StatTile label="Now worth" value={formatUsd(m.equity)} detail={`Cash ${formatUsd(m.cash)}`} />
        <StatTile
          label="Same money in VTI"
          value={m.summary?.sameFlowsInVti ? formatUsd(m.summary.sameFlowsInVti) : "—"}
          detail={
            m.summary?.since && m.summary.value
              ? `${m.summary.since} to ${m.summary.through} close; Trader ${formatUsd(m.summary.value)}`
              : "After the first close"
          }
        />
        <StatTile label="Held for a withdrawal" value={w ? formatUsd(w.outstanding) : formatUsd("0")} detail={w ? `${formatUsd(w.unfunded)} still to raise` : "Nothing open"} />
      </div>

      <Card title="Withdrawal">
        {!w && (
          <div className="grid gap-3 text-sm">
            <p className="text-[var(--muted)]">
              Trader sells what's needed (Claude chooses what), holds the cash until it settles, and emails you when it's ready. You then move it out in Alpaca.
            </p>
            <form method="get" action="/money/confirm" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="kind" value="request" />
              <label htmlFor="withdraw-amount" className="grid gap-1">
                <span className="text-xs text-[var(--muted)]">Amount (dollars, or all)</span>
                <input
                  id="withdraw-amount"
                  name="amount"
                  required
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="500"
                  pattern="^(\d+(\.\d{1,2})?|[Aa][Ll][Ll])$"
                  className="min-h-11 w-40 rounded-md border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-base sm:min-h-0"
                />
              </label>
              <button type="submit" className="min-h-11 rounded-md bg-[var(--text)] px-3 py-1.5 font-medium sm:min-h-0 text-[var(--background)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Withdraw…</button>
            </form>
          </div>
        )}
        {w && (
          <div className="grid gap-4 text-sm">
            <p>
              <span className="font-medium">{amountLabel(w.amount)}</span> requested {formatEt(w.requestedAt)}
              {w.withdrawn !== "0" && <> · {formatUsd(w.withdrawn)} withdrawn so far</>}
            </p>
            <ol className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {STEPS.map(([key, label, hint], i) => (
                <li key={key} className={`rounded-lg border p-2 ${i === step ? "border-[var(--text)]" : "border-[var(--border)]"}`}>
                  {i > step ? (
                    <span className="inline-flex items-center gap-1.5 text-[var(--muted)]"><span aria-hidden>○</span>{label}</span>
                  ) : (
                    <Status level={i < step ? "good" : "warn"}>
                      <span className="font-medium">{label}{i < step && <span className="sr-only"> (done)</span>}{i === step && <span className="sr-only"> (now)</span>}</span>
                    </Status>
                  )}
                  <div className="mt-1 text-xs text-[var(--muted)]">{i === 0 && w.planBy ? `Claude plans it by ${formatEt(w.planBy)}` : hint}</div>
                </li>
              ))}
            </ol>
            {w.status === "ready" && (
              <p className="font-medium">Start a {formatUsd(m.withdrawable ?? w.outstanding)} withdrawal in Alpaca. Trader matches it when it posts and closes the request.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {w.status === "planning" && <CommandLink kind="fund_now">Fund now…</CommandLink>}
              <CommandLink kind="cancel">Cancel withdrawal…</CommandLink>
            </div>
            {m.timeline.length > 0 && (
              <ul className="grid gap-1">
                {m.timeline.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-28 shrink-0 text-[var(--muted)]">{formatEt(e.at)}</span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {EVENT_LABELS[e.kind] ?? e.kind} <Badge>{e.actor}</Badge>
                      {e.reason && <span className="text-[var(--muted)]"> {e.reason}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Transfers">
        {m.ledger.length === 0 && <p className="text-sm text-[var(--muted)]">No transfers recorded.</p>}
        <RowsOnPhone>
          {m.ledger.map((f) => (
            <PhoneRow
              key={`${f.at}-${f.amount}`}
              title={KIND_LABELS[f.kind] ?? f.kind}
              value={formatUsd(f.amount)}
              detail={`${formatEt(f.at)}${f.approximate ? " (approx.)" : ""}`}
              secondary={f.status === "canceled" ? "canceled: left out" : (f.status ?? "")}
            />
          ))}
        </RowsOnPhone>
        <TableOnWide>
          <table className="w-full min-w-[24rem] text-sm">
            <tbody>
              {m.ledger.map((f) => (
                <tr key={`${f.at}-${f.amount}`} className="border-t border-[var(--border)] first:border-0">
                  <td className="py-1.5 text-[var(--muted)]">{formatEt(f.at)}{f.approximate && " (approx.)"}</td>
                  <td>{KIND_LABELS[f.kind] ?? f.kind}</td>
                  <td className="text-right font-medium">{formatUsd(f.amount)}</td>
                  <td className="text-right text-[var(--muted)]">{f.status === "canceled" ? "canceled: left out" : (f.status ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableOnWide>
      </Card>

      {(m.commands.length > 0 || m.past.length > 0) && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card title="Recent commands">
            <ul className="grid gap-1.5 text-sm">
              {m.commands.map((c, i) => (
                <li key={i}>
                  <span className="text-[var(--muted)]">{formatEt(c.at)}</span> {c.kind.replace("_", " ")} {c.amount && amountLabel(c.amount)} <Badge>{c.requestedBy}</Badge>{" "}
                  {c.outcome === "rejected" ? <Status level="bad">rejected: {c.reason}</Status> : c.outcome === "pending" ? <Status level="warn">waiting for the next tick</Status> : <Status level="good">accepted</Status>}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Past withdrawals">
            {m.past.length === 0 && <p className="text-sm text-[var(--muted)]">None yet.</p>}
            <ul className="grid gap-1.5 text-sm">
              {m.past.map((p, i) => (
                <li key={i}>
                  <span className="text-[var(--muted)]">{formatEt(p.requestedAt)}</span> {amountLabel(p.amount)}: {p.status === "withdrawn" ? `${formatUsd(p.withdrawn)} withdrawn` : "cancelled"}
                  {p.closedAt && <span className="text-[var(--muted)]"> · {formatEt(p.closedAt)}</span>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
