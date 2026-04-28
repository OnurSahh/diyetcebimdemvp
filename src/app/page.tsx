import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(circle_at_20%_20%,#d9f99d,transparent_35%),radial-gradient(circle_at_80%_0%,#67e8f9,transparent_30%),linear-gradient(160deg,#f8fafc,#ecfccb_35%,#f0fdf4_100%)] px-6 py-20 text-slate-900">
      <section className="w-full max-w-3xl rounded-3xl border border-white/60 bg-white/70 p-10 shadow-[0_20px_70px_-20px_rgba(15,23,42,0.35)] backdrop-blur-md">
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-emerald-700">Diet Yourself MVP</p>
        <h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl">
          A meal plan that adjusts when real life happens.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-700">
          Build your profile, generate today&apos;s plan, then tick or photo-log meals. The rest of the
          day rebalances automatically.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            className="rounded-full bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
            href="/signup"
          >
            Create Account
          </Link>
          <Link
            className="rounded-full border border-slate-300 bg-white/80 px-6 py-3 text-sm font-semibold text-slate-800 transition hover:bg-white"
            href="/login"
          >
            Log In
          </Link>
        </div>
      </section>
    </main>
  );
}
