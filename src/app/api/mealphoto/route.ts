import { NextResponse } from "next/server";
import { z } from "zod";

import { applyAdjustments } from "@/lib/adjustment/applyAdjustments";
import { withPortionAdjustmentNote } from "@/lib/adjustment/portionText";
import { generateVisionTextWithConfiguredProvider } from "@/lib/ai/visionProvider";
import { classifyMealComparison } from "@/lib/analysis/mealComparison";
import { adjustmentSummary, comparisonMessage } from "@/lib/copy/neutralMessages";
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

const mealOrder: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type VisionResult = {
  is_food_image: boolean;
  plan_action: "keep_same" | "replace_meal";
  detected_items: string[];
  portion_estimate: string;
  estimated_calories: number;
  macros: {
    protein: number;
    carbs: number;
    fat: number;
  };
  confidence: number;
  reasoning: string;
  replacement_meal?: {
    mealName: string;
    portionText: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
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
  const form = await request.formData();
  const plannedMealId = String(form.get("plannedMealId") || "");
  const photo = form.get("photo");

  const planText = String(form.get("plan") || "");
  const profileText = String(form.get("profile") || "");

  if (!plannedMealId || !(photo instanceof File) || !planText || !profileText) {
    return NextResponse.json({ error: "plannedMealId, photo, plan and profile are required" }, { status: 400 });
  }

  let plan: z.infer<typeof planSchema>;
  let profile: z.infer<typeof profileSchema>;

  try {
    plan = planSchema.parse(JSON.parse(planText));
    profile = profileSchema.parse(JSON.parse(profileText));
  } catch {
    return NextResponse.json({ error: "Invalid plan/profile payload" }, { status: 400 });
  }

  const meals = structuredClone(plan.plannedMeals);
  const currentIndex = meals.findIndex((meal) => meal.id === plannedMealId);
  if (currentIndex === -1) {
    return NextResponse.json({ error: "Meal not found" }, { status: 404 });
  }

  const plannedMeal = meals[currentIndex];
  if (plannedMeal.mealLogs.length > 0) {
    return NextResponse.json({ error: "Meal already logged" }, { status: 409 });
  }

  const hasUnloggedPreviousMeal = meals.some(
    (meal) =>
      mealOrder.indexOf(meal.mealSlot) < mealOrder.indexOf(plannedMeal.mealSlot) && meal.mealLogs.length === 0,
  );

  if (hasUnloggedPreviousMeal) {
    return NextResponse.json(
      { error: "Complete previous meals first (breakfast -> lunch -> dinner -> snack)." },
      { status: 409 },
    );
  }

  const photoBase64 = Buffer.from(await photo.arrayBuffer()).toString("base64");

  const analysisPrompt = `You are analyzing a meal photo against a planned meal.

Planned meal context:
- meal_slot: ${plannedMeal.mealSlot}
- meal_name: ${plannedMeal.mealName}
- planned_calories: ${plannedMeal.plannedCalories}
- planned_protein_g: ${plannedMeal.plannedProtein}
- planned_carbs_g: ${plannedMeal.plannedCarbs}
- planned_fat_g: ${plannedMeal.plannedFat}
- planned_portion: ${plannedMeal.portionText}

Task:
1) Estimate what is in the image.
1.1) Decide if this is actually a food meal image.
2) Estimate portion size in practical units.
3) Estimate calories and macros.
4) Decide plan_action: keep_same or replace_meal.
5) If replace_meal, provide replacement_meal structure.
6) Keep explanation short and neutral.

Return strict JSON only with keys:
- is_food_image
- plan_action
- detected_items
- portion_estimate
- estimated_calories
- macros(protein,carbs,fat)
- confidence
- reasoning
- replacement_meal`;

  let vision: VisionResult;
  try {
    const text = await generateVisionTextWithConfiguredProvider({
      prompt: analysisPrompt,
      mimeType: photo.type || "image/jpeg",
      base64Data: photoBase64,
    });
    vision = parseModelJson<VisionResult>(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Photo analysis failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!vision.is_food_image) {
    return NextResponse.json(
      { error: "This does not look like a food image. Please send a meal photo." },
      { status: 400 },
    );
  }

  const originalCalories = plannedMeal.plannedCalories;
  const shouldKeepSame = vision.plan_action !== "replace_meal";

  if (!shouldKeepSame) {
    const fallbackNameFromItems = (vision.detected_items ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 3)
      .join(" + ");

    plannedMeal.mealName =
      vision.replacement_meal?.mealName?.trim() ||
      (fallbackNameFromItems ? `Photo meal: ${fallbackNameFromItems}` : "Photo-detected meal");
    plannedMeal.portionText =
      vision.replacement_meal?.portionText?.trim() || vision.portion_estimate || plannedMeal.portionText;
    plannedMeal.plannedCalories = Math.max(
      50,
      Math.round(vision.replacement_meal?.calories ?? vision.estimated_calories ?? plannedMeal.plannedCalories),
    );
    plannedMeal.plannedProtein = Math.max(
      0,
      Math.round(vision.replacement_meal?.protein ?? vision.macros?.protein ?? plannedMeal.plannedProtein),
    );
    plannedMeal.plannedCarbs = Math.max(
      0,
      Math.round(vision.replacement_meal?.carbs ?? vision.macros?.carbs ?? plannedMeal.plannedCarbs),
    );
    plannedMeal.plannedFat = Math.max(
      0,
      Math.round(vision.replacement_meal?.fat ?? vision.macros?.fat ?? plannedMeal.plannedFat),
    );
  }

  const actualCalories = plannedMeal.plannedCalories;
  const actualProtein = plannedMeal.plannedProtein;
  const actualCarbs = plannedMeal.plannedCarbs;
  const actualFat = plannedMeal.plannedFat;

  const comparisonResult = shouldKeepSame
    ? classifyMealComparison({
        plannedCalories: originalCalories,
        actualCalories,
        isDifferentMeal: false,
      })
    : "different";

  plannedMeal.mealLogs = [
    {
      id: `log-${Date.now()}`,
      sourceType: shouldKeepSame ? "tick" : "photo",
      comparisonResult,
      actualCalories,
      actualProtein,
      actualCarbs,
      actualFat,
      confidence: Math.max(0, Math.min(1, vision.confidence ?? 0.8)),
      note: shouldKeepSame
        ? `Photo close to plan. Kept same. ${vision.reasoning ?? ""}`.trim()
        : `Meal replaced from photo. ${vision.reasoning ?? ""}`.trim(),
    },
  ];

  const remainingMeals = meals.filter(
    (meal) =>
      mealOrder.indexOf(meal.mealSlot) > mealOrder.indexOf(plannedMeal.mealSlot) && meal.mealLogs.length === 0,
  );

  const consumedAfter = sumConsumed(meals);
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

  if (remainingMeals.length > 0) {
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

  const updatedPlan = {
    ...plan,
    totalTargetCalories: meals.reduce((sum, meal) => sum + meal.plannedCalories, 0),
    plannedMeals: meals,
  };

  const deltaCalories = actualCalories - originalCalories;

  return NextResponse.json({
    plan: updatedPlan,
    adjustmentDetails,
    result: {
      action: shouldKeepSame ? "keep_same" : "replace_meal",
      detectedItems: vision.detected_items,
      portionEstimate: vision.portion_estimate,
      comparisonResult,
      confidence: Math.max(0, Math.min(1, vision.confidence ?? 0.6)),
      message: shouldKeepSame
        ? `Photo close to plan. Kept same and logged as eaten. ${vision.reasoning ?? ""}`.trim()
        : `${comparisonMessage(comparisonResult)} Replaced planned meal from photo. ${vision.reasoning ?? ""}`.trim(),
      adjustment: adjustmentSummary(deltaCalories),
    },
  });
}
