import { NextResponse } from "next/server";
import { z } from "zod";

import { generateDailyPlan } from "@/lib/mealplan/generateDailyPlan";

const profileSchema = z.object({
  calorieTarget: z.number().int().min(1000).max(5000),
  macroProteinTarget: z.number().int().min(0).max(400),
  macroCarbTarget: z.number().int().min(0).max(600),
  macroFatTarget: z.number().int().min(0).max(300),
  preferences: z.string().optional().nullable(),
  allergies: z.string().optional().nullable(),
  dislikes: z.string().optional().nullable(),
  edHistoryFlag: z.boolean().optional(),
});

const requestSchema = z.object({
  action: z.enum(["generate", "regenerate", "delete"]).default("generate"),
  profile: profileSchema,
});

const mealOrder = ["breakfast", "lunch", "dinner", "snack"] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { action, profile } = parsed.data;

  if (action === "delete") {
    return NextResponse.json({ plan: null });
  }

  try {
    const generated = await generateDailyPlan({
      calorieTarget: profile.calorieTarget,
      proteinTarget: profile.macroProteinTarget,
      carbTarget: profile.macroCarbTarget,
      fatTarget: profile.macroFatTarget,
      preferences: profile.preferences,
      allergies: profile.allergies,
      dislikes: profile.dislikes,
      edHistoryFlag: profile.edHistoryFlag ?? false,
    });

    const plannedMeals = [...generated.meals]
      .sort((a, b) => mealOrder.indexOf(a.mealSlot) - mealOrder.indexOf(b.mealSlot))
      .map((meal, index) => ({
        id: `meal-${meal.mealSlot}-${Date.now()}-${index}`,
        mealSlot: meal.mealSlot,
        mealName: meal.mealName,
        portionText: meal.portionText,
        plannedCalories: meal.calories,
        plannedProtein: meal.protein,
        plannedCarbs: meal.carbs,
        plannedFat: meal.fat,
        mealLogs: [] as Array<{
          id: string;
          sourceType: string;
          comparisonResult: string;
          actualCalories: number;
          actualProtein: number;
          actualCarbs: number;
          actualFat: number;
          confidence?: number | null;
          note?: string | null;
        }>,
      }));

    const plan = {
      id: `plan-${Date.now()}`,
      status: "draft",
      totalTargetCalories: plannedMeals.reduce((sum, meal) => sum + meal.plannedCalories, 0),
      plannedMeals,
    };

    return NextResponse.json({ plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meal generation failed";
    return NextResponse.json({ error: `AI meal generation failed: ${message}` }, { status: 502 });
  }
}
