import { MealSlot, PlanStatus, SourceType } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { applyAdjustments } from "@/lib/adjustment/applyAdjustments";
import { withPortionAdjustmentNote } from "@/lib/adjustment/portionText";
import { rewriteRemainingMeals } from "@/lib/mealplan/rewriteRemainingMeals";
import { generateTextWithConfiguredProvider } from "@/lib/ai/textProvider";
import { adjustmentSummary } from "@/lib/copy/neutralMessages";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/requireUser";

const tickSchema = z.object({
  action: z.literal("tick"),
  plannedMealId: z.string().min(1),
});

const manualSchema = z.object({
  action: z.literal("manual"),
  plannedMealId: z.string().min(1),
  actualCalories: z.number().int().min(50).max(2000),
  actualProtein: z.number().int().min(0).max(250),
  actualCarbs: z.number().int().min(0).max(350),
  actualFat: z.number().int().min(0).max(200),
  comparisonResult: z.enum(["match", "less", "more", "different"]),
});

const manualTextSchema = z.object({
  action: z.literal("manual_text"),
  plannedMealId: z.string().min(1),
  eatenText: z.string().optional().default(""),
});

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

function resolveComparisonResult(plannedCalories: number, actualCalories: number): "match" | "less" | "more" {
  const tolerance = Math.max(40, Math.round(plannedCalories * 0.12));
  const diff = actualCalories - plannedCalories;
  if (Math.abs(diff) <= tolerance) {
    return "match";
  }
  return diff > 0 ? "more" : "less";
}

type GeminiTextEstimate = {
  estimated_calories: number;
  macros: {
    protein: number;
    carbs: number;
    fat: number;
  };
  confidence: number;
  reasoning: string;
  normalized_meal?: {
    mealName: string;
    portionText: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
};

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export async function GET() {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  const date = startOfToday();
  const plan = await prisma.dailyPlan.findUnique({
    where: { userId_date: { userId: user!.id, date } },
    include: {
      plannedMeals: {
        orderBy: { mealSlot: "asc" },
        include: { mealLogs: true },
      },
    },
  });

  const adjustments = await prisma.adjustment.findMany({
    where: { userId: user!.id, date },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    plan,
    adjustments,
    profile: {
      calorieTarget: user!.calorieTarget,
      macroProteinTarget: user!.macroProteinTarget,
      macroCarbTarget: user!.macroCarbTarget,
      macroFatTarget: user!.macroFatTarget,
      preferences: user!.preferences,
      allergies: user!.allergies,
      dislikes: user!.dislikes,
    },
  });
}

export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  const body = (await request.json().catch(() => null)) as unknown;
  const tick = tickSchema.safeParse(body);
  const manual = manualSchema.safeParse(body);
  const manualText = manualTextSchema.safeParse(body);

  if (!tick.success && !manual.success && !manualText.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = tick.success ? tick.data : manual.success ? manual.data : manualText.data!;
  const date = startOfToday();

  const plannedMeal = await prisma.plannedMeal.findUnique({
    where: { id: payload.plannedMealId },
    include: {
      dailyPlan: true,
      mealLogs: true,
    },
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

  const order: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
  const currentIndex = order.indexOf(plannedMeal.mealSlot);
  const hasUnloggedPreviousMeal = orderedMeals.some(
    (meal) => order.indexOf(meal.mealSlot) < currentIndex && meal.mealLogs.length === 0,
  );

  if (hasUnloggedPreviousMeal) {
    return NextResponse.json(
      { error: "Complete previous meals first (breakfast -> lunch -> dinner -> snack)." },
      { status: 409 },
    );
  }

  let manualTextEstimate:
    | {
        actualCalories: number;
        actualProtein: number;
        actualCarbs: number;
        actualFat: number;
        comparisonResult: "match" | "less" | "more" | "different";
        confidence: number;
        note: string;
      }
    | null = null;

  if (manualText.success) {
    const eatenText = manualText.data.eatenText.trim();

    if (eatenText.length === 0) {
      manualTextEstimate = {
        actualCalories: 0,
        actualProtein: 0,
        actualCarbs: 0,
        actualFat: 0,
        comparisonResult: "less",
        confidence: 1,
        note: "Meal skipped by user.",
      };
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
${eatenText}

Task:
1) Estimate calories and macros from the written text.
2) Keep estimates realistic.
3) Rewrite the meal into a clearer planned format (mealName + portionText + macros).
3) Return strict JSON only.

JSON schema:
{
  "estimated_calories": 450,
  "macros": {
    "protein": 22,
    "carbs": 48,
    "fat": 15
  },
  "confidence": 0.78,
  "reasoning": "short reason",
  "normalized_meal": {
    "mealName": "string",
    "portionText": "string with concrete amounts",
    "calories": 450,
    "protein": 22,
    "carbs": 48,
    "fat": 15
  }
}`;

      let parsed: GeminiTextEstimate;
      try {
        const modelText = await generateTextWithConfiguredProvider(analysisPrompt);
        parsed = parseModelJson<GeminiTextEstimate>(modelText);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Manual meal analysis failed";
        return NextResponse.json({ error: message }, { status: 502 });
      }

      const actualCalories = Math.max(0, Math.round(parsed.estimated_calories ?? 0));
      const actualProtein = Math.max(0, Math.round(parsed.macros?.protein ?? 0));
      const actualCarbs = Math.max(0, Math.round(parsed.macros?.carbs ?? 0));
      const actualFat = Math.max(0, Math.round(parsed.macros?.fat ?? 0));

      const normalizedMeal = parsed.normalized_meal;
      const normalizedMealName = normalizedMeal?.mealName?.trim() || plannedMeal.mealName;
      const normalizedPortionText = normalizedMeal?.portionText?.trim() || `User wrote: ${eatenText}`;
      const normalizedCalories = Math.max(50, Math.round(normalizedMeal?.calories ?? actualCalories));
      const normalizedProtein = Math.max(0, Math.round(normalizedMeal?.protein ?? actualProtein));
      const normalizedCarbs = Math.max(0, Math.round(normalizedMeal?.carbs ?? actualCarbs));
      const normalizedFat = Math.max(0, Math.round(normalizedMeal?.fat ?? actualFat));

      await prisma.plannedMeal.update({
        where: { id: plannedMeal.id },
        data: {
          mealName: normalizedMealName,
          portionText: normalizedPortionText,
          plannedCalories: normalizedCalories,
          plannedProtein: normalizedProtein,
          plannedCarbs: normalizedCarbs,
          plannedFat: normalizedFat,
        },
      });

      manualTextEstimate = {
        actualCalories: normalizedCalories,
        actualProtein: normalizedProtein,
        actualCarbs: normalizedCarbs,
        actualFat: normalizedFat,
        comparisonResult: resolveComparisonResult(plannedMeal.plannedCalories, actualCalories),
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.7)),
        note: `Manual meal text: ${eatenText}. ${parsed.reasoning ?? ""}`.trim(),
      };
    }
  }

  const actual =
    payload.action === "tick"
      ? {
          actualCalories: plannedMeal.plannedCalories,
          actualProtein: plannedMeal.plannedProtein,
          actualCarbs: plannedMeal.plannedCarbs,
          actualFat: plannedMeal.plannedFat,
          comparisonResult: "match" as const,
          sourceType: SourceType.tick,
          confidence: 1,
          note: null as string | null,
        }
      : payload.action === "manual_text"
        ? {
            actualCalories: manualTextEstimate!.actualCalories,
            actualProtein: manualTextEstimate!.actualProtein,
            actualCarbs: manualTextEstimate!.actualCarbs,
            actualFat: manualTextEstimate!.actualFat,
            comparisonResult: manualTextEstimate!.comparisonResult,
            sourceType: SourceType.manual,
            confidence: manualTextEstimate!.confidence,
            note: manualTextEstimate!.note,
          }
      : {
          actualCalories: payload.actualCalories,
          actualProtein: payload.actualProtein,
          actualCarbs: payload.actualCarbs,
          actualFat: payload.actualFat,
          comparisonResult: payload.comparisonResult,
          sourceType: SourceType.manual,
          confidence: 0.8,
          note: null as string | null,
        };

  const mealLog = await prisma.mealLog.create({
    data: {
      userId: user!.id,
      plannedMealId: plannedMeal.id,
      date,
      mealSlot: plannedMeal.mealSlot,
      sourceType: actual.sourceType,
      actualCalories: actual.actualCalories,
      actualProtein: actual.actualProtein,
      actualCarbs: actual.actualCarbs,
      actualFat: actual.actualFat,
      comparisonResult: actual.comparisonResult,
      confidence: actual.confidence,
      note: actual.note,
    },
  });

  if (plannedMeal.dailyPlan.status === PlanStatus.draft) {
    await prisma.dailyPlan.update({
      where: { id: plannedMeal.dailyPlanId },
      data: { status: PlanStatus.locked },
    });
  }

  const deltaCalories = actual.actualCalories - plannedMeal.plannedCalories;
  const deltaProtein = actual.actualProtein - plannedMeal.plannedProtein;
  const deltaCarbs = actual.actualCarbs - plannedMeal.plannedCarbs;
  const deltaFat = actual.actualFat - plannedMeal.plannedFat;

  const remainingMeals = orderedMeals
    .filter(
      (meal) => order.indexOf(meal.mealSlot) > currentIndex && meal.mealLogs.length === 0,
    )
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
    calories: consumedBefore.calories + actual.actualCalories,
    protein: consumedBefore.protein + actual.actualProtein,
    carbs: consumedBefore.carbs + actual.actualCarbs,
    fat: consumedBefore.fat + actual.actualFat,
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

  const skippedMealSlots = [
    ...orderedMeals
    .filter((meal) => meal.mealLogs.some((log) => log.actualCalories === 0))
    .map((meal) => meal.mealSlot),
    ...(actual.actualCalories === 0 ? [plannedMeal.mealSlot] : []),
  ];

  let appliedCount = 0;
  const shouldRebalance =
    payload.action !== "tick" &&
    remainingMeals.length > 0 &&
    (deltaCalories !== 0 || deltaProtein !== 0 || deltaCarbs !== 0 || deltaFat !== 0);

  if (shouldRebalance) {
    const mealById = new Map(orderedMeals.map((meal) => [meal.id, meal]));
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
        date,
        triggeredByMealLogId: mealLog.id,
        summaryText: adjustmentSummary(deltaCalories),
        calorieDelta: deltaCalories,
        macroDeltaJson: JSON.stringify({
          protein: deltaProtein,
          carbs: deltaCarbs,
          fat: deltaFat,
        }),
        appliedToMealsJson: JSON.stringify(adjustmentDetails),
      },
    });
  }

  const updatedPlan = await prisma.dailyPlan.findUnique({
    where: { id: plannedMeal.dailyPlanId },
    include: { plannedMeals: { orderBy: { mealSlot: "asc" } } },
  });

  return NextResponse.json({ ok: true, mealLog, adjustmentDetails, plan: updatedPlan });
}
