"use client";

import { useEffect, useMemo, useState } from "react";

type Meal = {
  id: string;
  mealSlot: "breakfast" | "lunch" | "dinner" | "snack";
  mealName: string;
  portionText: string;
  plannedCalories: number;
  plannedProtein: number;
  plannedCarbs: number;
  plannedFat: number;
  mealLogs: Array<{
    id: string;
    sourceType: string;
    comparisonResult: string;
    actualCalories: number;
    actualProtein: number;
    actualCarbs: number;
    actualFat: number;
  }>;
};

type PlanResponse = {
  plan: {
    id: string;
    status: string;
    totalTargetCalories: number;
    plannedMeals: Meal[];
  } | null;
  adjustments?: Array<{ id: string; summaryText: string }>;
  profile?: {
    calorieTarget: number | null;
    macroProteinTarget: number | null;
    macroCarbTarget: number | null;
    macroFatTarget: number | null;
    preferences: string | null;
    allergies: string | null;
    dislikes: string | null;
  };
};

type ProgressRingProps = {
  label: string;
  current: number;
  target: number;
  color: string;
};

type AdjustmentDetail = {
  plannedMealId: string;
  mealSlot: "breakfast" | "lunch" | "dinner" | "snack";
  oldCalories: number;
  newCalories: number;
  oldProtein: number;
  newProtein: number;
  oldCarbs: number;
  newCarbs: number;
  oldFat: number;
  newFat: number;
  oldPortionText: string;
  newPortionText: string;
};

function ProgressRing({ label, current, target, color }: ProgressRingProps) {
  const normalizedTarget = Math.max(1, target);
  const clamped = Math.max(0, Math.min(current / normalizedTarget, 1));
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped);

  return (
    <div className="rounded-2xl bg-white/80 p-4 text-center shadow-sm">
      <svg width="96" height="96" viewBox="0 0 96 96" className="mx-auto">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="48"
          cy="48"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <p className="mt-2 text-sm font-semibold text-slate-900">{label}</p>
      <p className="text-xs text-slate-600">
        {Math.round(current)} / {Math.round(target)}
      </p>
    </div>
  );
}

function summarizePreferences(payload: PlanResponse | null): string {
  if (!payload?.profile) {
    return "your profile";
  }

  const parts = [payload.profile.preferences, payload.profile.allergies, payload.profile.dislikes]
    .filter((value) => value && value.trim().length > 0)
    .map((value) => value!.trim());

  return parts.length > 0 ? parts.join(" | ") : "your profile";
}

export default function DashboardPage() {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState("");
  const [planActionLoading, setPlanActionLoading] = useState<
    "generate" | "regenerate" | "delete" | null
  >(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [tickingMealId, setTickingMealId] = useState<string | null>(null);
  const [uploadingMealId, setUploadingMealId] = useState<string | null>(null);
  const [manualMealId, setManualMealId] = useState<string | null>(null);
  const [photoModalMealId, setPhotoModalMealId] = useState<string | null>(null);
  const [selectedPhotoFile, setSelectedPhotoFile] = useState<File | null>(null);
  const [mealTextById, setMealTextById] = useState<Record<string, string>>({});
  const [adjustmentModal, setAdjustmentModal] = useState<{
    title: string;
    details: AdjustmentDetail[];
  } | null>(null);

  function maybeOpenAdjustmentModal(title: string, details?: AdjustmentDetail[]) {
    if (!details || details.length === 0) {
      return;
    }
    setAdjustmentModal({ title, details });
  }

  async function loadData() {
    const res = await fetch("/api/tracker");
    if (!res.ok) {
      setError("Please log in and complete onboarding first.");
      return;
    }
    const payload = (await res.json()) as PlanResponse;
    setData(payload);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
  }, []);

  const totals = useMemo(() => {
    const meals = data?.plan?.plannedMeals ?? [];
    const planned = meals.reduce((sum, meal) => sum + meal.plannedCalories, 0);
    const plannedProtein = meals.reduce((sum, meal) => sum + meal.plannedProtein, 0);
    const plannedCarbs = meals.reduce((sum, meal) => sum + meal.plannedCarbs, 0);
    const plannedFat = meals.reduce((sum, meal) => sum + meal.plannedFat, 0);
    const consumed = meals.reduce((sum, meal) => {
      const firstLog = meal.mealLogs[0];
      return sum + (firstLog ? firstLog.actualCalories : 0);
    }, 0);

    const consumedProtein = meals.reduce((sum, meal) => {
      const firstLog = meal.mealLogs[0];
      return sum + (firstLog ? firstLog.actualProtein : 0);
    }, 0);

    const consumedCarbs = meals.reduce((sum, meal) => {
      const firstLog = meal.mealLogs[0];
      return sum + (firstLog ? firstLog.actualCarbs : 0);
    }, 0);

    const consumedFat = meals.reduce((sum, meal) => {
      const firstLog = meal.mealLogs[0];
      return sum + (firstLog ? firstLog.actualFat : 0);
    }, 0);

    const goalCalories =
      data?.profile?.calorieTarget ?? data?.plan?.totalTargetCalories ?? Math.max(1, planned);
    const goalProtein = data?.profile?.macroProteinTarget ?? Math.max(1, plannedProtein);
    const goalCarbs = data?.profile?.macroCarbTarget ?? Math.max(1, plannedCarbs);
    const goalFat = data?.profile?.macroFatTarget ?? Math.max(1, plannedFat);

    return {
      planned,
      plannedProtein,
      plannedCarbs,
      plannedFat,
      consumed,
      consumedProtein,
      consumedCarbs,
      consumedFat,
      goalCalories,
      goalProtein,
      goalCarbs,
      goalFat,
    };
  }, [data]);

  async function generatePlan(action: "generate" | "regenerate" | "delete") {
    setPlanActionLoading(action);
    setError("");
    const res = await fetch("/api/mealplan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setPlanActionLoading(null);

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error || "Could not generate plan");
      return;
    }

    await loadData();
  }

  async function logout() {
    setLoggingOut(true);
    setError("");

    const res = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    setLoggingOut(false);

    if (!res.ok) {
      setError("Could not log out. Please try again.");
      return;
    }

    window.location.href = "/login";
  }

  async function tickMeal(plannedMealId: string) {
    setTickingMealId(plannedMealId);
    setError("");
    const res = await fetch("/api/tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tick", plannedMealId }),
    });
    setTickingMealId(null);

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      adjustmentDetails?: AdjustmentDetail[];
      plan?: PlanResponse["plan"];
    };

    if (!res.ok) {
      setError(body.error || "Could not mark meal");
      return;
    }

    maybeOpenAdjustmentModal("Adjustments applied after logging this meal", body.adjustmentDetails);

    await loadData();
  }

  async function submitPhoto(plannedMealId: string) {
    if (!selectedPhotoFile) {
      setError("Please choose a photo first.");
      return;
    }

    setUploadingMealId(plannedMealId);
    setError("");

    const formData = new FormData();
    formData.append("plannedMealId", plannedMealId);
    formData.append("photo", selectedPhotoFile);

    const res = await fetch("/api/mealphoto", {
      method: "POST",
      body: formData,
    });

    setUploadingMealId(null);

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      adjustmentDetails?: AdjustmentDetail[];
    };

    if (!res.ok) {
      setError(body.error || "Could not analyze meal");
      return;
    }

    maybeOpenAdjustmentModal("Adjustments applied from photo", body.adjustmentDetails);
    setPhotoModalMealId(null);
    setSelectedPhotoFile(null);
    await loadData();
  }

  async function submitManualMealText(plannedMealId: string) {
    setManualMealId(plannedMealId);
    setError("");

    const res = await fetch("/api/tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "manual_text",
        plannedMealId,
        eatenText: mealTextById[plannedMealId] ?? "",
      }),
    });

    setManualMealId(null);

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      adjustmentDetails?: AdjustmentDetail[];
      plan?: PlanResponse["plan"];
    };

    if (!res.ok) {
      setError(body.error || "Could not log manual meal");
      return;
    }

    setMealTextById((current) => ({ ...current, [plannedMealId]: "" }));
    maybeOpenAdjustmentModal("Adjustments applied after manual update", body.adjustmentDetails);
    await loadData();
  }

  const orderedMeals = useMemo(() => {
    const order = ["breakfast", "lunch", "dinner", "snack"];
    const meals = data?.plan?.plannedMeals ?? [];
    return [...meals].sort((a, b) => order.indexOf(a.mealSlot) - order.indexOf(b.mealSlot));
  }, [data]);

  return (
    <main className="app-gradient-bg min-h-screen px-6 py-10">
      <section className="mx-auto w-full max-w-6xl space-y-6">
      <header className="glass-card rounded-3xl p-6 shadow-[0_20px_70px_-20px_rgba(15,23,42,0.35)]">
        <div className="flex justify-end">
          <button
            className="cursor-pointer rounded-full border border-slate-300 bg-white/80 px-4 py-2 text-sm font-semibold transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void logout()}
            disabled={loggingOut || Boolean(planActionLoading)}
          >
            {loggingOut ? "Logging out..." : "Log out"}
          </button>
        </div>
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-700">Today dashboard</p>
        <h1 className="mt-2 text-3xl">Your daily flow: generate, log, adjust</h1>
        <p className="mt-3 text-sm text-slate-700">
          Goal: {totals.goalCalories} kcal • Taken: {totals.consumed} kcal
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-white/75 px-3 py-2 text-sm text-slate-700">1. Generate plan</div>
          <div className="rounded-xl bg-white/75 px-3 py-2 text-sm text-slate-700">2. Tick or upload meal photo</div>
          <div className="rounded-xl bg-white/75 px-3 py-2 text-sm text-slate-700">3. See automatic same-day adjustments</div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button className="cursor-pointer rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60" onClick={() => void generatePlan("generate")} disabled={Boolean(planActionLoading)}>
            {planActionLoading === "generate" ? "Generating..." : "Generate Today Plan"}
          </button>
          <button className="cursor-pointer rounded-full border border-slate-300 bg-white/80 px-4 py-2 text-sm font-semibold transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60" onClick={() => void generatePlan("regenerate")} disabled={Boolean(planActionLoading)}>
            {planActionLoading === "regenerate" ? "Regenerating..." : "Regenerate"}
          </button>
          <button className="cursor-pointer rounded-full border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60" onClick={() => void generatePlan("delete")} disabled={Boolean(planActionLoading)}>
            {planActionLoading === "delete" ? "Deleting..." : "Delete Plan"}
          </button>
        </div>
      </header>

      <section className="glass-card rounded-3xl p-6 shadow-[0_20px_70px_-20px_rgba(15,23,42,0.35)]">
        <h2 className="text-2xl">Today summary</h2>
        {orderedMeals.length > 0 ? (
          <p className="mt-2 text-sm text-slate-700">
            Based off of your preferences ({summarizePreferences(data)}), we have generated the meal plan below for you.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-700">
            Generate today&apos;s meal plan to see your personalized meals and progress targets.
          </p>
        )}
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ProgressRing
            label="Calories"
            current={totals.consumed}
            target={Math.max(1, totals.goalCalories)}
            color="#0f766e"
          />
          <ProgressRing
            label="Protein (g)"
            current={totals.consumedProtein}
            target={Math.max(1, totals.goalProtein)}
            color="#2563eb"
          />
          <ProgressRing
            label="Carbs (g)"
            current={totals.consumedCarbs}
            target={Math.max(1, totals.goalCarbs)}
            color="#7c3aed"
          />
          <ProgressRing
            label="Fat (g)"
            current={totals.consumedFat}
            target={Math.max(1, totals.goalFat)}
            color="#b45309"
          />
        </div>
      </section>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <section className="grid gap-4 md:grid-cols-2">
        {orderedMeals.map((meal, index) => {
          const status = meal.mealLogs.length > 0 ? "completed" : "pending";
          const manualTextValue = mealTextById[meal.id] ?? "";
          const manualTextEmpty = manualTextValue.trim().length === 0;
          const isBlockedByOrder = orderedMeals
            .slice(0, index)
            .some((previousMeal) => previousMeal.mealLogs.length === 0);
          const actionBusy =
            Boolean(planActionLoading) ||
            tickingMealId === meal.id ||
            uploadingMealId === meal.id ||
            manualMealId === meal.id;
          const disableMealActions = isBlockedByOrder || actionBusy;

          return (
            <article key={meal.id} className="glass-card rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-xl capitalize">{index + 1}. {meal.mealSlot}</h2>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase text-slate-700">{status}</span>
              </div>
              <p className="mt-2 text-base font-semibold text-slate-900">{meal.mealName}</p>
              <p className="mt-1 text-sm text-slate-600">{meal.portionText}</p>
              <p className="mt-3 text-sm text-slate-700">
                {meal.plannedCalories} kcal • P {meal.plannedProtein}g • C {meal.plannedCarbs}g • F {meal.plannedFat}g
              </p>

              {meal.mealLogs.length === 0 ? (
                <div className="mt-4 space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      WHAT DID YOU EAT INSTEAD?
                    </label>
                    <div className="relative">
                      <textarea
                        className="min-h-[88px] w-full rounded-xl border border-slate-300 bg-white/85 px-3 py-2 pr-24 text-sm outline-none ring-emerald-500 transition focus:ring"
                        placeholder="e.g. 1 bowl lentil soup + 1 slice bread"
                        value={manualTextValue}
                        onChange={(event) =>
                          setMealTextById((current) => ({ ...current, [meal.id]: event.target.value }))
                        }
                        disabled={disableMealActions}
                      />
                      <button
                        className="absolute bottom-3 right-3 cursor-pointer rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => void submitManualMealText(meal.id)}
                        disabled={disableMealActions || manualTextEmpty}
                      >
                        {manualMealId === meal.id ? "Sending..." : "Send"}
                      </button>
                    </div>
                    <button
                      className="w-full cursor-pointer rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => {
                        setMealTextById((current) => ({ ...current, [meal.id]: "" }));
                        void submitManualMealText(meal.id);
                      }}
                      disabled={disableMealActions}
                    >
                      {manualMealId === meal.id ? "Marking skip..." : "I skipped this meal"}
                    </button>
                  </div>

                  <button
                    className="w-full cursor-pointer rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void tickMeal(meal.id)}
                    disabled={disableMealActions}
                  >
                    {tickingMealId === meal.id ? "Logging..." : "Tick as eaten"}
                  </button>

                  <button className="w-full cursor-pointer rounded-xl border border-slate-300 bg-white/80 px-4 py-2 text-sm font-semibold transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60" type="button" disabled={disableMealActions} onClick={() => { setSelectedPhotoFile(null); setPhotoModalMealId(meal.id); }}>
                      {uploadingMealId === meal.id ? "Sending photo..." : "Send photo"}
                  </button>

                  {isBlockedByOrder ? (
                    <p className="text-xs font-medium text-amber-700">
                      Complete previous meal(s) first.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-emerald-700">Meal logged.</p>
              )}
            </article>
          );
        })}
      </section>

      {photoModalMealId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Send meal photo</h3>
            <p className="mt-1 text-sm text-slate-600">
              Upload a clear photo of your meal. Non-food images will be rejected.
            </p>
            <input
              className="mt-4 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              type="file"
              accept="image/*"
              onChange={(event) => setSelectedPhotoFile(event.target.files?.[0] ?? null)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold"
                onClick={() => {
                  setPhotoModalMealId(null);
                  setSelectedPhotoFile(null);
                }}
                disabled={uploadingMealId === photoModalMealId}
              >
                Cancel
              </button>
              <button
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                onClick={() => void submitPhoto(photoModalMealId)}
                disabled={!selectedPhotoFile || uploadingMealId === photoModalMealId}
              >
                {uploadingMealId === photoModalMealId ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {adjustmentModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{adjustmentModal.title}</h3>
              <button className="rounded-lg border border-slate-300 px-3 py-1 text-sm" onClick={() => setAdjustmentModal(null)}>
                Close
              </button>
            </div>
            <div className="mt-4 max-h-[55vh] space-y-3 overflow-auto">
              {adjustmentModal.details.map((item) => (
                <article key={item.plannedMealId} className="rounded-xl border border-slate-200 p-3">
                  <p className="text-sm font-semibold capitalize text-slate-900">{item.mealSlot}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Calories {item.oldCalories} {"->"} {item.newCalories} | P {item.oldProtein} {"->"} {item.newProtein} | C {item.oldCarbs} {"->"} {item.newCarbs} | F {item.oldFat} {"->"} {item.newFat}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">Before: {item.oldPortionText}</p>
                  <p className="mt-1 text-xs text-slate-700">After: {item.newPortionText}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      </section>
    </main>
  );
}
