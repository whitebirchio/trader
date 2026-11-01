export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Trader</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Private dashboard. Sign in with the owner&apos;s Google account.</p>
      </div>
      <a
        href="/auth/start"
        className="rounded-lg bg-[var(--text)] px-4 py-3 text-center font-medium text-[var(--background)] hover:opacity-90"
      >
        Sign in with Google
      </a>
    </main>
  );
}
