"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    setLoading(false);

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Signup failed");
      return;
    }

    router.push("/onboarding");
  }

  return (
    <main className="app-gradient-bg min-h-screen px-6 py-14">
      <section className="glass-card mx-auto w-full max-w-md rounded-3xl p-8 shadow-[0_20px_70px_-20px_rgba(15,23,42,0.35)]">
      <h1 className="text-3xl">Create your account</h1>
      <p className="mt-2 text-sm text-slate-600">Start with email and password.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <input
          className="w-full rounded-xl border border-slate-300 px-4 py-3"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full rounded-xl border border-slate-300 px-4 py-3"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-70"
          type="submit"
          disabled={loading}
        >
          {loading ? "Creating..." : "Create account"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-slate-700">
        Already have an account?{" "}
        <button
          type="button"
          className="font-semibold text-emerald-700 underline underline-offset-2"
          onClick={() => router.push("/login")}
        >
          Log in
        </button>
      </p>
      </section>
    </main>
  );
}
