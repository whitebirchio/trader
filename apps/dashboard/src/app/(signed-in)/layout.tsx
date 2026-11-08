import Link from "next/link";
import { signedIn } from "@/lib/auth";

const NAV = [
  ["/", "Overview"],
  ["/holdings", "Holdings"],
  ["/money", "Money"],
  ["/strategy", "Strategy"],
  ["/track-record", "Track record"],
  ["/activity", "Activity"],
] as const;

export default async function SignedInLayout({ children }: { children: React.ReactNode }) {
  const { config } = await signedIn();
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-[max(env(safe-area-inset-top),1rem)]">
      {config.env === "staging" && (
        <div className="mb-3 rounded-lg border border-[var(--warn)] px-3 py-1.5 text-center text-xs font-semibold tracking-wide text-[var(--warn)]">STAGING · paper</div>
      )}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 text-sm">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-2.5 py-1.5 hover:bg-[var(--border)]">{label}</Link>
          ))}
        </nav>
        <form action="/auth/logout" method="post">
          <button className="text-xs text-[var(--muted)] hover:text-[var(--text)]">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
