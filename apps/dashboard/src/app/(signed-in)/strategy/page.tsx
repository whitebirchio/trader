import Link from "next/link";
import { strategyHistory, strategyView } from "@trader/core";
import { StrategyDocument } from "@/components/strategy-document";
import { Card } from "@/components/ui";
import { signedIn } from "@/lib/auth";
import { formatEt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function StrategyPage() {
  const { db } = await signedIn();
  const now = new Date();
  const [v, history] = await Promise.all([strategyView(db, now), strategyHistory(db)]);
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">
        Version {v.version} by {v.authoredBy}, {formatEt(v.createdAt)}. Reaffirmed {v.daysSinceReaffirmed} day{v.daysSinceReaffirmed === 1 ? "" : "s"} ago; theses go stale in {v.staleInDays} day{v.staleInDays === 1 ? "" : "s"} unless resubmitted.
      </p>
      <StrategyDocument document={v.document} states={v.theses} />
      <Card title="History">
        <ul className="grid gap-2 text-sm">
          {history.map((h) => (
            <li key={h.version} className="flex gap-3">
              <Link href={`/strategy/${h.version}`} className="w-10 shrink-0 font-medium underline decoration-[var(--border)] underline-offset-2">v{h.version}</Link>
              <span className="w-28 shrink-0 text-xs text-[var(--muted)] sm:w-36 sm:text-sm">{h.createdAt ? formatEt(h.createdAt) : "initial"} · {h.authoredBy}</span>
              <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{h.summary}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
