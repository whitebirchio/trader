import Link from "next/link";
import { notFound } from "next/navigation";
import { type Strategy, strategyVersion } from "@trader/core";
import { StrategyDocument } from "@/components/strategy-document";
import { signedIn } from "@/lib/auth";
import { formatEt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function StrategyVersionPage({ params }: { params: Promise<{ version: string }> }) {
  const { db } = await signedIn();
  const { version } = await params;
  if (!/^\d{1,6}$/.test(version)) notFound();
  const v = await strategyVersion(db, Number(version));
  if (!v) notFound();
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-[var(--muted)]">
        <Link href="/strategy" className="underline underline-offset-2">← Active strategy</Link> · Version {v.version} by {v.authoredBy}
        {v.createdAt ? `, ${formatEt(v.createdAt)}` : ""}
      </p>
      <StrategyDocument document={v.document as Strategy} />
    </div>
  );
}
