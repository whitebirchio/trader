import { Nav, Refresh } from "@/components/nav";
import { signedIn } from "@/lib/auth";

function SignOut({ className }: { className?: string }) {
  return (
    <form action="/auth/logout" method="post" className={className}>
      <button className="min-h-11 text-xs text-[var(--muted)] hover:text-[var(--text)] sm:min-h-0">Sign out</button>
    </form>
  );
}

export default async function SignedInLayout({ children }: { children: React.ReactNode }) {
  const { config } = await signedIn();
  return (
    <div className="mx-auto max-w-5xl pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[max(env(safe-area-inset-top),1rem)] sm:pb-16">
      {config.env === "staging" && (
        <div className="mb-3 rounded-lg border border-[var(--warn)] px-3 py-1.5 text-center text-xs font-semibold tracking-wide text-[var(--warn)]">STAGING · paper</div>
      )}
      <header className="mb-4 flex items-center gap-2 sm:mb-5 sm:gap-3">
        <Nav />
        <Refresh />
        <SignOut className="hidden sm:block" />
      </header>
      {children}
      {/* On phones, sign-out lives at the foot of every page: available, but out of the way. */}
      <footer className="mt-8 flex justify-center border-t border-[var(--border)] pt-2 sm:hidden">
        <SignOut />
      </footer>
    </div>
  );
}
