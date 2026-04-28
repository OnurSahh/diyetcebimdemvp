import { NextResponse } from "next/server";
import { z } from "zod";

import { applyAdjustments } from "@/lib/adjustment/applyAdjustments";
import { withPortionAdjustmentNote } from "@/lib/adjustment/portionText";
import { generateTextWithConfiguredProvider } from "@/lib/ai/textProvider";
import { adjustmentSummary } from "@/lib/copy/neutralMessages";
import { rewriteRemainingMeals } from "@/lib/mealplan/rewriteRemainingMeals";

type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

const mealLogSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  comparisonResult: z.string(),
  actualCalories: z.number(),
  actualProtein: z.number(),
  actualCarbs: z.number(),
  actualFat: z.number(),
  confidence: z.number().optional().nullable(),
  note: z.string().optional().nullable(),
});

const mealSchema = z.object({
  id: z.string(),
  mealSlot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  mealName: z.string(),
  portionText: z.string(),
  plannedCalories: z.number(),
  plannedProtein: z.number(),
  plannedCarbs: z.number(),
  plannedFat: z.number(),
  mealLogs: z.array(mealLogSchema),
});

const planSchema = z.object({
  id: z.string(),
  status: z.string(),
  totalTargetCalories: z.number(),
  plannedMeals: z.array(mealSchema),
});

const profileSchema = z.object({
  calorieTarget: z.number(),
  macroProteinTarget: z.number(),
  macroCarbTarget: z.number(),
  macroFatTarget: z.number(),
  preferences: z.string().optional().nullable(),
  allergies: z.string().optional().nullable(),
  dislikes: z.string().optional().nullable(),
});

const requestSchema = z.object({
  action: z.enum(["tick", "manual_text"]),
  plannedMealId: z.string(),
  eatenText: z.string().optional().default(""),
  plan: planSchema,
  profile: profileSchema,
});

const order: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type ManualEstimate = {
  actualCalories: number;
  actualProtein: number;
  actualCarbs: number;
  actualFat: number;
  confidence: number;
  reasoning: string;
  normalizedMeal?: {
    mealName?: string;
    portionText?: string;
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
  };
};

function stripCodeFences(value: string): string {
  return value.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
}

function parseModelJson<T>(value: string): T {
  const cleaned = stripCodeFences(value).trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Model response did not contain a JSON object");
    }
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
  }
}

function resolveComparisonResult(plannedCalories: number, actualCalories: number): "match" | "less" | "more" {
  const tolerance = Math.max(40, Math.round(plannedCalories * 0.12));
  const diff = actualCalories - plannedCalories;
  if (Math.abs(diff) <= tolerance) {
    return "match";
  }
  return diff > 0 ? "more" : "less";
}

function sumConsumed(meals: Array<z.infer<typeof mealSchema>>) {
  return meals.reduce(
    (sum, meal) => {
      const firstLog = meal.mealLogs[0];
      if (!firstLog) {
        return sum;
      }
      return {
        calories: sum.calories + firstLog.actualCalories,
        protein: sum.protein + firstLog.actualProtein,
        carbs: sum.carbs + firstLog.actualCarbs,
        fat: sum.fat + firstLog.actualFat,
      };
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { action, plannedMealId, eatenText, profile } = parsed.data;
  const updatedPlan = structuredClone(parsed.data.plan);
  const meals = updatedPlan.plannedMeals;

  const currentIndex = meals.findIndex((meal) => meal.id === plannedMealId);
  if (currentIndex === -1) {
    return NextResponse.json({ error: "Meal not found" }, { status: 404 });
  }

  const plannedMeal = meals[currentIndex];
  if (plannedMeal.mealLogs.length > 0) {
    return NextResponse.json({ error: "Meal already logged" }, { status: 409 });
  }

  const hasUnloggedPreviousMeal = meals.some(
    (meal) => order.indexOf(meal.mealSlot) < order.indexOf(plannedMeal.mealSlot) && meal.mealLogs.length === 0,
  );
  if (hasUnloggedPreviousMeal) {
    return NextResponse.json(
      { error: "Complete previous meals first (breakfast -> lunch -> dinner -> snack)." },
      { status: 409 },
    );
  }

  let actualCalories = plannedMeal.plannedCalories;
  let actualProtein = plannedMeal.plannedProtein;
  let actualCarbs = plannedMeal.plannedCarbs;
  let actualFat = plannedMeal.plannedFat;
  let comparisonResult: "match" | "less" | "more" | "different" = "match";
  let sourceType = "tick";
  let confidence = 1;
  let note: string | null = null;

  if (action === "manual_text") {
    sourceType = "manual";
    const trimmed = eatenText.trim();

    if (trimmed.length === 0) {
      actualCalories = 0;
      actualProtein = 0;
      actualCarbs = 0;
      actualFat = 0;
      comparisonResult = "less";
      confidence = 1;
      note = "Meal skipped by user.";
    } else {
      const analysisPrompt = `You estimate nutrition from a short user meal text.

Planned meal context:
- meal_slot: ${plannedMeal.mealSlot}
- meal_name: ${plannedMeal.mealName}
- planned_calories: ${plannedMeal.plannedCalories}
- planned_protein_g: ${plannedMeal.plannedProtein}
- planned_carbs_g: ${plannedMeal.plannedCarbs}
- planned_fat_g: ${plannedMeal.plannedFat}

User written meal text:
${trimmed}

Task:
1) Estimate calories and macros from the written text.
2) Keep estimates realistic.
3) Rewrite the meal into a clearer planned format (mealName + portionText + macros).
4) Return strict JSON only.

JSON schema:
{
  "actualCalories": 450,
  "actualProtein": 22,
  "actualCarbs": 48,
  "actualFat": 15,
  "confidence": 0.78,
  "reasoning": "short reason",
  "normalizedMeal": {
    "mealName": "string",
    "portionText": "string with concrete amounts",
    "calories": 450,
    "protein": 22,
    "carbs": 48,
    "fat": 15
  }
}`;

      let estimate: ManualEstimate;
      try {
        const text = await generateTextWithConfiguredProvider(analysisPrompt);
        estimate = parseModelJson<ManualEstimate>(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Manual meal analysis failed";
        return NextResponse.json({ error: message }, { status: 502 });
      }

      actualCalories = Math.max(0, Math.round(estimate.actualCalories ?? 0));
      actualProtein = Math.max(0, Math.round(estimate.actualProtein ?? 0));
      actualCarbs = Math.max(0, Math.round(estimate.actualCarbs ?? 0));
      actualFat = Math.max(0, Math.round(estimate.actualFat ?? 0));
      comparisonResult = resolveComparisonResult(plannedMeal.plannedCalories, actualCalories);
      confidence = Math.max(0, Math.min(1, estimate.confidence ?? 0.7));
      note = `Manual meal text: ${trimmed}. ${estimate.reasoning ?? ""}`.trim();

      if (estimate.normalizedMeal) {
        plannedMeal.mealName = estimate.normalizedMeal.mealName?.trim() || plannedMeal.mealName;
        plannedMeal.portionText =
          estimate.normalizedMeal.portionText?.trim() || `User wrote: ${trimmed}`;
        plannedMeal.plannedCalories = Math.max(50, Math.round(estimate.normalizedMeal.calories ?? actualCalories));
        plannedMeal.plannedProtein = Math.max(0, Math.round(estimate.normalizedMeal.protein ?? actualProtein));
        plannedMeal.plannedCarbs = Math.max(0, Math.round(estimate.normalizedMeal.carbs ?? actualCarbs));
        plannedMeal.plannedFat = Math.max(0, Math.round(estimate.normalizedMeal.fat ?? actualFat));
      }
    }
  }

  plannedMeal.mealLogs = [
    {
      id: `log-${Date.now()}`,
      sourceType,
      comparisonResult,
      actualCalories,
      actualProtein,
      actualCarbs,
      actualFat,
      confidence,
      note,
    },
  ];

  const consumedAfter = sumConsumed(meals);
  const remainingMeals = meals.filter(
    (meal) => order.indexOf(meal.mealSlot) > order.indexOf(plannedMeal.mealSlot) && meal.mealLogs.length === 0,
  );

  const targetRemaining = {
    calories: Math.max(0, profile.calorieTarget - consumedAfter.calories),
    protein: Math.max(0, profile.macroProteinTarget - consumedAfter.protein),
    carbs: Math.max(0, profile.macroCarbTarget - consumedAfter.carbs),
    fat: Math.max(0, profile.macroFatTarget - consumedAfter.fat),
  };

  const remainingTotals = remainingMeals.reduce(
    (sum, meal) => ({
      calories: sum.calories + meal.plannedCalories,
      protein: sum.protein + meal.plannedProtein,
      carbs: sum.carbs + meal.plannedCarbs,
      fat: sum.fat + meal.plannedFat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const skippedMealSlots = meals
    .filter((meal) => meal.mealLogs.some((log) => log.actualCalories === 0))
    .map((meal) => meal.mealSlot);

  const adjustmentDetails: Array<{
    plannedMealId: string;
    mealSlot: MealSlot;
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
  }> = [];

  const deltaCalories = actualCalories - plannedMeal.plannedCalories;
  const deltaProtein = actualProtein - plannedMeal.plannedProtein;
  const deltaCarbs = actualCarbs - plannedMeal.plannedCarbs;
  const deltaFat = actualFat - plannedMeal.plannedFat;

  const shouldRebalance =
    action !== "tick" &&
    remainingMeals.length > 0 &&
    (deltaCalories !== 0 || deltaProtein !== 0 || deltaCarbs !== 0 || deltaFat !== 0);

  if (shouldRebalance) {
    try {
      const rewritten = await rewriteRemainingMeals({
        calorieTarget: targetRemaining.calories,
        proteinTarget: targetRemaining.protein,
        carbTarget: targetRemaining.carbs,
        fatTarget: targetRemaining.fat,
        preferences: profile.preferences,
        allergies: profile.allergies,
        dislikes: profile.dislikes,
        skippedMealSlots,
        remainingMeals: remainingMeals.map((meal) => ({
          id: meal.id,
          mealSlot: meal.mealSlot,
          mealName: meal.mealName,
          portionText: meal.portionText,
          plannedCalories: meal.plannedCalories,
          plannedProtein: meal.plannedProtein,
          plannedCarbs: meal.plannedCarbs,
          plannedFat: meal.plannedFat,
        })),
      });

      for (const entry of rewritten) {
        const targetMeal = meals.find((meal) => meal.id === entry.id);
        if (!targetMeal) {
          continue;
        }
        adjustmentDetails.push({
          plannedMealId: targetMeal.id,
          mealSlot: targetMeal.mealSlot,
          oldCalories: targetMeal.plannedCalories,
          newCalories: entry.calories,
          oldProtein: targetMeal.plannedProtein,
          newProtein: entry.protein,
          oldCarbs: targetMeal.plannedCarbs,
          newCarbs: entry.carbs,
          oldFat: targetMeal.plannedFat,
          newFat: entry.fat,
          oldPortionText: targetMeal.portionText,
          newPortionText: entry.portionText,
        });
        targetMeal.mealName = entry.mealName;
        targetMeal.portionText = entry.portionText;
        targetMeal.plannedCalories = entry.calories;
        targetMeal.plannedProtein = entry.protein;
        targetMeal.plannedCarbs = entry.carbs;
        targetMeal.plannedFat = entry.fat;
      }
    } catch {
      const adjustment = applyAdjustments(
        remainingMeals.map((meal) => ({
          id: meal.id,
          mealSlot: meal.mealSlot,
          totals: {
            plannedCalories: meal.plannedCalories,
            plannedProtein: meal.plannedProtein,
            plannedCarbs: meal.plannedCarbs,
            plannedFat: meal.plannedFat,
          },
        })),
        {
        calories: remainingTotals.calories - targetRemaining.calories,
        protein: remainingTotals.protein - targetRemaining.protein,
        carbs: remainingTotals.carbs - targetRemaining.carbs,
        fat: remainingTotals.fat - targetRemaining.fat,
        },
      );

      for (const entry of adjustment.applied) {
        const targetMeal = meals.find((meal) => meal.id === entry.plannedMealId);
        if (!targetMeal) {
          continue;
        }

        const newPortionText = withPortionAdjustmentNote({
          originalPortionText: targetMeal.portionText,
          oldCalories: targetMeal.plannedCalories,
          newCalories: entry.newCalories,
        });

        adjustmentDetails.push({
          plannedMealId: targetMeal.id,
          mealSlot: targetMeal.mealSlot,
          oldCalories: targetMeal.plannedCalories,
          newCalories: entry.newCalories,
          oldProtein: targetMeal.plannedProtein,
          newProtein: entry.newProtein,
          oldCarbs: targetMeal.plannedCarbs,
          newCarbs: entry.newCarbs,
          oldFat: targetMeal.plannedFat,
          newFat: entry.newFat,
          oldPortionText: targetMeal.portionText,
          newPortionText,
        });

        targetMeal.plannedCalories = entry.newCalories;
        targetMeal.plannedProtein = entry.newProtein;
        targetMeal.plannedCarbs = entry.newCarbs;
        targetMeal.plannedFat = entry.newFat;
        targetMeal.portionText = newPortionText;
      }
    }
  }

  updatedPlan.totalTargetCalories = meals.reduce((sum, meal) => sum + meal.plannedCalories, 0);

  return NextResponse.json({
    plan: updatedPlan,
    adjustmentDetails,
    result: {
      adjustment: adjustmentSummary(deltaCalories),
    },
  });
}
