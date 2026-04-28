import { SourceType } from "@prisma/client";
import { NextResponse } from "next/server";

import { applyAdjustments } from "@/lib/adjustment/applyAdjustments";
import { withPortionAdjustmentNote } from "@/lib/adjustment/portionText";
import { rewriteRemainingMeals } from "@/lib/mealplan/rewriteRemainingMeals";
import { generateVisionTextWithConfiguredProvider } from "@/lib/ai/visionProvider";
import { classifyMealComparison } from "@/lib/analysis/mealComparison";
import { adjustmentSummary, comparisonMessage } from "@/lib/copy/neutralMessages";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/requireUser";

const mealOrder = ["breakfast", "lunch", "dinner", "snack"] as const;

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

    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate) as T;
  }
}

type GeminiPhotoResult = {
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

export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  const form = await request.formData();
  const plannedMealId = String(form.get("plannedMealId") || "");
  const photo = form.get("photo");

  if (!plannedMealId) {
    return NextResponse.json({ error: "plannedMealId is required" }, { status: 400 });
  }

  if (!(photo instanceof File)) {
    return NextResponse.json({ error: "photo file is required" }, { status: 400 });
  }

  const plannedMeal = await prisma.plannedMeal.findUnique({
    where: { id: plannedMealId },
    include: { dailyPlan: true, mealLogs: true },
  });

  if (!plannedMeal || plannedMeal.dailyPlan.userId !== user!.id) {
    return NextResponse.json({ error: "Meal not found" }, { status: 404 });
  }

  if (plannedMeal.mealLogs.length > 0) {
    return NextResponse.json({ error: "Meal already logged" }, { status: 409 });
  }

  const orderedMeals = await prisma.plannedMeal.findMany({
    where: { dailyPlanId: plannedMeal.dailyPlanId },
    include: { mealLogs: true },
    orderBy: { mealSlot: "asc" },
  });

  const currentIndex = mealOrder.indexOf(plannedMeal.mealSlot);
  const hasUnloggedPreviousMeal = orderedMeals.some(
    (meal) => mealOrder.indexOf(meal.mealSlot) < currentIndex && meal.mealLogs.length === 0,
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
2) Estimate portion size in practical units (grams, tablespoons, cups, bowls, slices, pieces).
3) Estimate calories and macros.
4) Decide plan_action:
   - keep_same: use when image is close enough to planned meal (roughly same food and portion).
   - replace_meal: use when image is clearly different food or portion.
5) If plan_action is replace_meal, provide replacement_meal in the same structure as generated meal plan entries.
6) Keep explanation short and neutral.

Return strict JSON only:
{
  "is_food_image": true,
  "plan_action": "keep_same|replace_meal",
  "detected_items": ["item1", "item2"],
  "portion_estimate": "string",
  "estimated_calories": 640,
  "macros": {
    "protein": 35,
    "carbs": 68,
    "fat": 24
  },
  "confidence": 0.78,
  "reasoning": "short explanation",
  "replacement_meal": {
    "mealName": "string",
    "portionText": "string",
    "calories": 640,
    "protein": 35,
    "carbs": 68,
    "fat": 24
  }
}`;

  let geminiResult: GeminiPhotoResult;
  try {
    const text = await generateVisionTextWithConfiguredProvider({
      prompt: analysisPrompt,
      mimeType: photo.type || "image/jpeg",
      base64Data: photoBase64,
    });
    geminiResult = parseModelJson<GeminiPhotoResult>(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Photo analysis failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const shouldKeepSame = geminiResult.plan_action !== "replace_meal";
  const replacement = geminiResult.replacement_meal;

  if (!geminiResult.is_food_image) {
    return NextResponse.json(
      { error: "This does not look like a food image. Please send a meal photo." },
      { status: 400 },
    );
  }

  const updatedPlanned = shouldKeepSame
    ? {
        mealName: plannedMeal.mealName,
        portionText: plannedMeal.portionText,
        plannedCalories: plannedMeal.plannedCalories,
        plannedProtein: plannedMeal.plannedProtein,
        plannedCarbs: plannedMeal.plannedCarbs,
        plannedFat: plannedMeal.plannedFat,
      }
    : {
        mealName: replacement?.mealName?.trim() || plannedMeal.mealName,
        portionText: replacement?.portionText?.trim() || geminiResult.portion_estimate || plannedMeal.portionText,
        plannedCalories: Math.max(50, Math.round(replacement?.calories ?? geminiResult.estimated_calories ?? plannedMeal.plannedCalories)),
        plannedProtein: Math.max(0, Math.round(replacement?.protein ?? geminiResult.macros?.protein ?? plannedMeal.plannedProtein)),
        plannedCarbs: Math.max(0, Math.round(replacement?.carbs ?? geminiResult.macros?.carbs ?? plannedMeal.plannedCarbs)),
        plannedFat: Math.max(0, Math.round(replacement?.fat ?? geminiResult.macros?.fat ?? plannedMeal.plannedFat)),
      };

  if (!shouldKeepSame) {
    await prisma.plannedMeal.update({
      where: { id: plannedMeal.id },
      data: {
        mealName: updatedPlanned.mealName,
        portionText: updatedPlanned.portionText,
        plannedCalories: updatedPlanned.plannedCalories,
        plannedProtein: updatedPlanned.plannedProtein,
        plannedCarbs: updatedPlanned.plannedCarbs,
        plannedFat: updatedPlanned.plannedFat,
      },
    });
  }

  const actualCalories = updatedPlanned.plannedCalories;
  const actualProtein = updatedPlanned.plannedProtein;
  const actualCarbs = updatedPlanned.plannedCarbs;
  const actualFat = updatedPlanned.plannedFat;

  const comparisonResult = shouldKeepSame
    ? classifyMealComparison({
        plannedCalories: plannedMeal.plannedCalories,
        actualCalories,
        isDifferentMeal: false,
      })
    : "different";

  const mealLog = await prisma.mealLog.create({
    data: {
      userId: user!.id,
      plannedMealId: plannedMeal.id,
      date: plannedMeal.date,
      mealSlot: plannedMeal.mealSlot,
      sourceType: shouldKeepSame ? SourceType.tick : SourceType.photo,
      actualCalories,
      actualProtein,
      actualCarbs,
      actualFat,
      comparisonResult,
      confidence: Math.max(0, Math.min(1, geminiResult.confidence ?? 0.8)),
      note: shouldKeepSame
        ? `Photo close to plan. Kept same. ${geminiResult.reasoning ?? ""}`.trim()
        : `Meal replaced from photo. ${geminiResult.reasoning ?? ""}`.trim(),
    },
  });

  const deltaCalories = actualCalories - plannedMeal.plannedCalories;
  const deltaProtein = actualProtein - plannedMeal.plannedProtein;
  const deltaCarbs = actualCarbs - plannedMeal.plannedCarbs;
  const deltaFat = actualFat - plannedMeal.plannedFat;

  if (plannedMeal.dailyPlan.status === "draft") {
    await prisma.dailyPlan.update({
      where: { id: plannedMeal.dailyPlanId },
      data: { status: "locked" },
    });
  }

  const allMeals = await prisma.plannedMeal.findMany({
    where: { dailyPlanId: plannedMeal.dailyPlanId },
    include: { mealLogs: true },
  });

  const remainingMeals = allMeals
    .filter((meal) => mealOrder.indexOf(meal.mealSlot) > currentIndex && meal.mealLogs.length === 0)
    .map((meal) => ({
      id: meal.id,
      mealSlot: meal.mealSlot,
      totals: {
        plannedCalories: meal.plannedCalories,
        plannedProtein: meal.plannedProtein,
        plannedCarbs: meal.plannedCarbs,
        plannedFat: meal.plannedFat,
      },
    }));

  const adjustmentDetails: Array<{
    plannedMealId: string;
    mealSlot: string;
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

  const remainingTotals = remainingMeals.reduce(
    (sum, meal) => ({
      calories: sum.calories + meal.totals.plannedCalories,
      protein: sum.protein + meal.totals.plannedProtein,
      carbs: sum.carbs + meal.totals.plannedCarbs,
      fat: sum.fat + meal.totals.plannedFat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const consumedBefore = orderedMeals.reduce(
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

  const consumedAfter = {
    calories: consumedBefore.calories + actualCalories,
    protein: consumedBefore.protein + actualProtein,
    carbs: consumedBefore.carbs + actualCarbs,
    fat: consumedBefore.fat + actualFat,
  };

  const baseTargets = {
    calories: user!.calorieTarget ?? plannedMeal.dailyPlan.totalTargetCalories,
    protein: user!.macroProteinTarget ?? consumedAfter.protein + remainingTotals.protein,
    carbs: user!.macroCarbTarget ?? consumedAfter.carbs + remainingTotals.carbs,
    fat: user!.macroFatTarget ?? consumedAfter.fat + remainingTotals.fat,
  };

  const targetRemaining = {
    calories: Math.max(0, baseTargets.calories - consumedAfter.calories),
    protein: Math.max(0, baseTargets.protein - consumedAfter.protein),
    carbs: Math.max(0, baseTargets.carbs - consumedAfter.carbs),
    fat: Math.max(0, baseTargets.fat - consumedAfter.fat),
  };

  const skippedMealSlots = orderedMeals
    .filter((meal) => meal.mealLogs.some((log) => log.actualCalories === 0))
    .map((meal) => meal.mealSlot);

  let appliedCount = 0;
  const mealById = new Map(allMeals.map((meal) => [meal.id, meal]));

  if (remainingMeals.length > 0) {
    try {
      const rewritten = await rewriteRemainingMeals({
        calorieTarget: targetRemaining.calories,
        proteinTarget: targetRemaining.protein,
        carbTarget: targetRemaining.carbs,
        fatTarget: targetRemaining.fat,
        preferences: user!.preferences,
        allergies: user!.allergies,
        dislikes: user!.dislikes,
        skippedMealSlots,
        remainingMeals: remainingMeals.map((meal) => ({
          id: meal.id,
          mealSlot: meal.mealSlot,
          mealName: mealById.get(meal.id)?.mealName ?? "",
          portionText: mealById.get(meal.id)?.portionText ?? "",
          plannedCalories: meal.totals.plannedCalories,
          plannedProtein: meal.totals.plannedProtein,
          plannedCarbs: meal.totals.plannedCarbs,
          plannedFat: meal.totals.plannedFat,
        })),
      });

      await prisma.$transaction(
        rewritten.map((entry) => {
          const oldMeal = mealById.get(entry.id)!;
          adjustmentDetails.push({
            plannedMealId: entry.id,
            mealSlot: entry.mealSlot,
            oldCalories: oldMeal.plannedCalories,
            newCalories: entry.calories,
            oldProtein: oldMeal.plannedProtein,
            newProtein: entry.protein,
            oldCarbs: oldMeal.plannedCarbs,
            newCarbs: entry.carbs,
            oldFat: oldMeal.plannedFat,
            newFat: entry.fat,
            oldPortionText: oldMeal.portionText,
            newPortionText: entry.portionText,
          });

          return prisma.plannedMeal.update({
            where: { id: entry.id },
            data: {
              mealName: entry.mealName,
              portionText: entry.portionText,
              plannedCalories: entry.calories,
              plannedProtein: entry.protein,
              plannedCarbs: entry.carbs,
              plannedFat: entry.fat,
            },
          });
        }),
      );
      appliedCount = rewritten.length;
    } catch {
      const adjustment = applyAdjustments(remainingMeals, {
        calories: remainingTotals.calories - targetRemaining.calories,
        protein: remainingTotals.protein - targetRemaining.protein,
        carbs: remainingTotals.carbs - targetRemaining.carbs,
        fat: remainingTotals.fat - targetRemaining.fat,
      });

      if (adjustment.applied.length > 0) {
        await prisma.$transaction(
          adjustment.applied.map((entry) => {
            const oldMeal = mealById.get(entry.plannedMealId)!;
            const newPortionText = withPortionAdjustmentNote({
              originalPortionText: oldMeal.portionText,
              oldCalories: oldMeal.plannedCalories,
              newCalories: entry.newCalories,
            });

            adjustmentDetails.push({
              plannedMealId: entry.plannedMealId,
              mealSlot: entry.mealSlot,
              oldCalories: oldMeal.plannedCalories,
              newCalories: entry.newCalories,
              oldProtein: oldMeal.plannedProtein,
              newProtein: entry.newProtein,
              oldCarbs: oldMeal.plannedCarbs,
              newCarbs: entry.newCarbs,
              oldFat: oldMeal.plannedFat,
              newFat: entry.newFat,
              oldPortionText: oldMeal.portionText,
              newPortionText,
            });

            return prisma.plannedMeal.update({
              where: { id: entry.plannedMealId },
              data: {
                plannedCalories: entry.newCalories,
                plannedProtein: entry.newProtein,
                plannedCarbs: entry.newCarbs,
                plannedFat: entry.newFat,
                portionText: newPortionText,
              },
            });
          }),
        );
        appliedCount = adjustment.applied.length;
      }
    }
  }

  if (appliedCount > 0 || deltaCalories !== 0 || deltaProtein !== 0 || deltaCarbs !== 0 || deltaFat !== 0) {
    await prisma.adjustment.create({
      data: {
        userId: user!.id,
        date: plannedMeal.date,
        triggeredByMealLogId: mealLog.id,
        summaryText: adjustmentSummary(deltaCalories),
        calorieDelta: deltaCalories,
        macroDeltaJson: JSON.stringify({ protein: deltaProtein, carbs: deltaCarbs, fat: deltaFat }),
        appliedToMealsJson: JSON.stringify(adjustmentDetails),
      },
    });
  }

  const updatedPlan = await prisma.dailyPlan.findUnique({
    where: { id: plannedMeal.dailyPlanId },
    include: { plannedMeals: { orderBy: { mealSlot: "asc" } } },
  });

  return NextResponse.json({
    plan: updatedPlan,
    adjustmentDetails,
    result: {
      action: shouldKeepSame ? "keep_same" : "replace_meal",
      estimated: {
        calories: actualCalories,
        protein: actualProtein,
        carbs: actualCarbs,
        fat: actualFat,
      },
      detectedItems: geminiResult.detected_items,
      portionEstimate: geminiResult.portion_estimate,
      comparisonResult,
      confidence: Math.max(0, Math.min(1, geminiResult.confidence ?? 0.6)),
      message: shouldKeepSame
        ? `Photo close to plan. Kept same and logged as eaten. ${geminiResult.reasoning ?? ""}`.trim()
        : `${comparisonMessage(comparisonResult)} Replaced planned meal from photo. ${geminiResult.reasoning ?? ""}`.trim(),
      adjustment: adjustmentSummary(deltaCalories),
    },
  });
}
