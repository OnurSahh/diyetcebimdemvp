"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const activityLevels = [
  { value: "sedentary", label: "Sedentary (little to no exercise)" },
  { value: "light", label: "Light (1-2 workouts per week)" },
  { value: "moderate", label: "Moderate (3-4 workouts per week)" },
  { value: "active", label: "Active (5-6 workouts per week)" },
  { value: "very_active", label: "Very active (daily intense activity)" },
] as const;

const goals = [
  { value: "maintain", label: "Maintain weight" },
  { value: "cut", label: "Fat loss (cut)" },
  { value: "bulk", label: "Muscle gain (bulk)" },
] as const;

const comfortLevels = [
  { value: "low", label: "Low - smaller portions feel better" },
  { value: "medium", label: "Medium - standard portions are fine" },
  { value: "high", label: "High - larger portions are comfortable" },
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(event.currentTarget);
    const payload = {
      age: Number(formData.get("age")),
      sexGender: String(formData.get("sexGender")),
      heightCm: Number(formData.get("heightCm")),
      weightKg: Number(formData.get("weightKg")),
      activityLevel: String(formData.get("activityLevel")),
      goal: String(formData.get("goal")),
      preferences: String(formData.get("preferences") || ""),
      allergies: String(formData.get("allergies") || ""),
      dislikes: String(formData.get("dislikes") || ""),
      edHistoryFlag: formData.get("edHistoryFlag") === "on",
      edTriggerNotes: String(formData.get("edTriggerNotes") || ""),
      portionComfort: String(formData.get("portionComfort")),
    };

    const res = await fetch("/api/survey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setLoading(false);

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not save onboarding");
      return;
    }

    router.push("/dashboard");
  }

  return (
    <main className="app-gradient-bg min-h-screen px-6 py-12">
      <section className="glass-card mx-auto w-full max-w-3xl rounded-3xl p-8 shadow-[0_20px_70px_-20px_rgba(15,23,42,0.35)]">
      <h1 className="text-3xl">Onboarding</h1>
      <p className="mt-2 text-sm text-slate-600">
        This app is not medical advice. If meal planning increases anxiety, speak to a clinician.
      </p>

      <form onSubmit={onSubmit} className="mt-8 grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Age</span>
          <input className="w-full rounded-xl border border-slate-300 px-4 py-3" name="age" placeholder="Age" type="number" required />
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Sex</span>
          <select className="w-full rounded-xl border border-slate-300 px-4 py-3" name="sexGender" required>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Height (cm)</span>
          <input className="w-full rounded-xl border border-slate-300 px-4 py-3" name="heightCm" placeholder="Height (cm)" type="number" step="0.1" required />
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Weight (kg)</span>
          <input className="w-full rounded-xl border border-slate-300 px-4 py-3" name="weightKg" placeholder="Weight (kg)" type="number" step="0.1" required />
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Activity level</span>
          <select className="w-full rounded-xl border border-slate-300 px-4 py-3" name="activityLevel" required>
            {activityLevels.map((level) => (
              <option key={level.value} value={level.value}>{level.label}</option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          <span>Goal</span>
          <select className="w-full rounded-xl border border-slate-300 px-4 py-3" name="goal" required>
            {goals.map((goal) => (
              <option key={goal.value} value={goal.value}>{goal.label}</option>
            ))}
          </select>
        </label>

        <input className="rounded-xl border border-slate-300 px-4 py-3 sm:col-span-2" name="preferences" placeholder="Dietary preferences (e.g., vegetarian, halal, pescatarian, dairy-free)" />
        <input className="rounded-xl border border-slate-300 px-4 py-3" name="allergies" placeholder="Allergies" />
        <input className="rounded-xl border border-slate-300 px-4 py-3" name="dislikes" placeholder="Foods to avoid" />

        <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
          <input type="checkbox" name="edHistoryFlag" />
          I have a history of anorexia, bulimia, or binge eating.
        </label>

        <textarea
          className="min-h-24 rounded-xl border border-slate-300 px-4 py-3 sm:col-span-2"
          name="edTriggerNotes"
          placeholder="Foods or patterns that trigger anxiety (optional)"
        />

        <label className="space-y-2 text-sm font-medium text-slate-700 sm:col-span-2">
          <span>Portion comfort level</span>
          <select className="w-full rounded-xl border border-slate-300 px-4 py-3" name="portionComfort" required>
            {comfortLevels.map((level) => (
              <option key={level.value} value={level.value}>{level.label}</option>
            ))}
          </select>
          <p className="text-xs font-normal text-slate-500">
            This helps us keep meal portions aligned with your comfort around portion sizes.
          </p>
        </label>

        {error ? <p className="text-sm text-red-600 sm:col-span-2">{error}</p> : null}

        <button
          className="rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white sm:col-span-2"
          type="submit"
          disabled={loading}
        >
          {loading ? "Saving..." : "Save and continue"}
        </button>
      </form>
      </section>
    </main>
  );
}
