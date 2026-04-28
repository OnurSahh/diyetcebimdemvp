import { PlanStatus } from "@prisma/client";
import { NextResponse } from "next/server";

import { generateDailyPlan } from "@/lib/mealplan/generateDailyPlan";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/requireUser";

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
      plannedMeals: { orderBy: { mealSlot: "asc" } },
      _count: { select: { plannedMeals: true } },
    },
  });

  return NextResponse.json({ plan });
}

export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: "generate" | "regenerate" | "lock" | "delete";
  };
  const action = body.action ?? "generate";

  if (!user!.calorieTarget || !user!.macroProteinTarget || !user!.macroCarbTarget || !user!.macroFatTarget) {
    return NextResponse.json({ error: "Finish onboarding first" }, { status: 400 });
  }

  const date = startOfToday();

  if (action === "lock") {
    const existing = await prisma.dailyPlan.findUnique({
      where: { userId_date: { userId: user!.id, date } },
      include: { plannedMeals: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "No daily plan to lock" }, { status: 404 });
    }

    const locked = await prisma.dailyPlan.update({
      where: { userId_date: { userId: user!.id, date } },
      data: { status: PlanStatus.locked },
      include: { plannedMeals: true },
    });
    return NextResponse.json({ plan: locked });
  }

  if (action === "delete") {
    const existing = await prisma.dailyPlan.findUnique({
      where: { userId_date: { userId: user!.id, date } },
    });

    if (!existing) {
      return NextResponse.json({ plan: null });
    }

    await prisma.$transaction([
      prisma.mealLog.deleteMany({ where: { plannedMeal: { dailyPlanId: existing.id } } }),
      prisma.plannedMeal.deleteMany({ where: { dailyPlanId: existing.id } }),
      prisma.adjustment.deleteMany({ where: { userId: user!.id, date } }),
      prisma.dailyPlan.delete({ where: { id: existing.id } }),
    ]);

    return NextResponse.json({ plan: null });
  }

  const existing = await prisma.dailyPlan.findUnique({
    where: { userId_date: { userId: user!.id, date } },
    include: { plannedMeals: true },
  });

  if (existing && existing.status === PlanStatus.locked && action === "generate") {
    return NextResponse.json({ plan: existing });
  }

  let generated;
  try {
    generated = await generateDailyPlan({
      calorieTarget: user!.calorieTarget,
      proteinTarget: user!.macroProteinTarget,
      carbTarget: user!.macroCarbTarget,
      fatTarget: user!.macroFatTarget,
      preferences: user!.preferences,
      allergies: user!.allergies,
      dislikes: user!.dislikes,
      edHistoryFlag: user!.edHistoryFlag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meal generation failed";
    return NextResponse.json({ error: `Gemini meal generation failed: ${message}` }, { status: 502 });
  }

  const totalTargetCalories = generated.meals.reduce((sum, meal) => sum + meal.calories, 0);

  const plan = await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.plannedMeal.deleteMany({ where: { dailyPlanId: existing.id } });
      await tx.mealLog.deleteMany({ where: { plannedMeal: { dailyPlanId: existing.id } } });
      await tx.adjustment.deleteMany({ where: { userId: user!.id, date } });
    }

    const saved = await tx.dailyPlan.upsert({
      where: { userId_date: { userId: user!.id, date } },
      update: {
        status: PlanStatus.draft,
        totalTargetCalories,
      },
      create: {
        userId: user!.id,
        date,
        status: PlanStatus.draft,
        totalTargetCalories,
      },
    });

    for (const meal of generated.meals) {
      await tx.plannedMeal.create({
        data: {
          dailyPlanId: saved.id,
          date,
          mealSlot: meal.mealSlot,
          mealName: meal.mealName,
          portionText: meal.portionText,
          plannedCalories: meal.calories,
          plannedProtein: meal.protein,
          plannedCarbs: meal.carbs,
          plannedFat: meal.fat,
        },
      });
    }

    return tx.dailyPlan.findUnique({
      where: { id: saved.id },
      include: { plannedMeals: { orderBy: { mealSlot: "asc" } } },
    });
  });

  return NextResponse.json({ plan });
}
