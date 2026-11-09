import Link from "next/link";
import { moneyView, parseAmount } from "@trader/core";
import { Card } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { COMMAND_KINDS, type CommandKind, csrfToken } from "@/lib/commands";
import { formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The confirmation step (SPEC-capital): repeats exactly what will be sent.
 * Reached by a GET from the Money page, which changes nothing; only this
 * page's POST form, with its anti-forgery token, queues a command.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ kind?: string; amount?: string }> }) {
  const { config, db, email } = await signedIn();
  const params = await searchParams;
  const kind = (COMMAND_KINDS as readonly string[]).includes(params.kind ?? "") ? (params.kind as CommandKind) : null;
  const m = await moneyView(db, new Date());
  const w = m.withdrawal;

  let problem: string | null = null;
  let amount: string | null = null;
  let what = "";
  if (!kind) problem = "Unknown command.";
  else if (kind === "request") {
    const parsed = parseAmount(params.amount ?? null);
    if (!parsed.ok) problem = `${parsed.reason[0]?.toUpperCase()}${parsed.reason.slice(1)}.`;
    else if (w) problem = "A withdrawal is already open. Cancel it first.";
    else {
      amount = parsed.amount ?? "all";
      what = amount === "all" ? `Withdraw everything (about ${formatUsd(m.equity)}): sell every holding and hold the cash.` : `Withdraw ${formatUsd(amount)}: sell enough to raise it and hold the cash.`;
    }
  } else if (!w) problem = "There's no open withdrawal.";
  else if (kind === "fund_now") {
    if (w.status !== "planning") problem = "It's already past planning.";
    else what = `Fund the ${w.amount === "all" ? "everything" : formatUsd(w.amount)} withdrawal now: skip Claude's plan and let the fallback sell from VTI and the systematic sleeve, keeping your theses.`;
  } else {
    what = `Cancel the ${w.amount === "all" ? "everything" : formatUsd(w.amount)} withdrawal. The held cash is reinvested at the next rebalance step.`;
  }

  const csrf = await csrfToken(config, email, Math.floor(Date.now() / 1000));
  return (
    <div className="grid max-w-xl grid-cols-1 gap-4">
      <Card title="Confirm">
        {problem ? (
          <div className="grid gap-3 text-sm">
            <p>{problem}</p>
            <Link href="/money" className="underline">Back to Money</Link>
          </div>
        ) : (
          <form method="post" action="/money/command" className="grid gap-4 text-sm">
            <p className="text-base font-medium">{what}</p>
            {kind === "request" && (
              <p className="text-[var(--muted)]">
                Nothing leaves the account from here. When the cash has settled you'll get an email, and you start the transfer in Alpaca yourself. You can cancel at any point until then.
              </p>
            )}
            <input type="hidden" name="kind" value={kind ?? ""} />
            {amount && <input type="hidden" name="amount" value={amount} />}
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="confirm" value="yes" />
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="min-h-11 rounded-md bg-[var(--text)] px-3 sm:min-h-0 py-1.5 font-medium text-[var(--background)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                {kind === "request" ? "Confirm withdrawal" : kind === "fund_now" ? "Confirm: fund now" : "Confirm: cancel withdrawal"}
              </button>
              <Link href="/money" className="rounded-md px-3 py-1.5 hover:bg-[var(--border)]">Back</Link>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
