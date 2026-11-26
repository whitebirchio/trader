import type { Exits } from "@trader/core";
import { formatDays, formatPct, formatUsd, shortDate } from "@/lib/format";
import { Status } from "./ui";

/** Every way a position can end (SPEC-dashboard Amendment 3): the automatic exits as figures, the routine's conditions, and the flags on it now. */
export function ExitList({ exits }: { exits: Exits }) {
  const days = (n: number) => (n <= 0 ? (n === 0 ? "today" : `${formatDays(-n)} ago`) : `in ${formatDays(n)}`);
  return (
    <div className="text-sm">
      <ul className="space-y-1">
        <li>
          <span className="text-[var(--muted)]">Stop:</span> sells if it closes below {formatUsd(exits.stop.price)} ({formatPct(exits.stop.belowPct, 2, false)} below today)
        </li>
        {exits.review && (
          <li>
            <span className="text-[var(--muted)]">Review:</span> re-judged by {shortDate(exits.review.date)} ({days(exits.review.daysLeft)}), and sold unless renewed
          </li>
        )}
        <li>
          <span className="text-[var(--muted)]">Goes stale:</span> {shortDate(exits.stale.date)} ({days(exits.stale.daysLeft)}) if the routine stops reaffirming it
        </li>
      </ul>
      {exits.exitIf.length > 0 && (
        <>
          <p className="mt-2 text-[var(--muted)]">Sells sooner if:</p>
          <ul className="ml-4 list-disc">
            {exits.exitIf.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {exits.flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {exits.flags.map((f) => (
            <li key={f.flag}>
              <Status level={f.flag === "earnings_soon" ? "warn" : "bad"}>{f.text}</Status>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
