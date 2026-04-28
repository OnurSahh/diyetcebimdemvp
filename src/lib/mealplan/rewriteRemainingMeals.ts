import { MealSlot } from "@prisma/client";
import { generateTextWithConfiguredProvider } from "@/lib/ai/textProvider";

type RemainingMeal = {
  id: string;
  mealSlot: MealSlot;
  mealName: string;
  portionText: string;
  plannedCalories: number;
  plannedProtein: number;
  plannedCarbs: number;
  plannedFat: number;
};

type Totals = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type RewriteInput = {
  calorieTarget: number;
  proteinTarget: number;
  carbTarget: number;
  fatTarget: number;
  preferences?: string | null;
  allergies?: string | null;
  dislikes?: string | null;
  skippedMealSlots?: MealSlot[];
  remainingMeals: RemainingMeal[];
};

type RewrittenMeal = {
  id: string;
  mealSlot: MealSlot;
  mealName: string;
  portionText: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
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

function sumTotals(meals: RemainingMeal[]): Totals {
  return meals.reduce(
    (sum, meal) => ({
      calories: sum.calories + meal.plannedCalories,
      protein: sum.protein + meal.plannedProtein,
      carbs: sum.carbs + meal.plannedCarbs,
      fat: sum.fat + meal.plannedFat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function normalizeRewrittenMeals(raw: unknown, remainingMeals: RemainingMeal[]): RewrittenMeal[] {
  const slotSet = new Set(remainingMeals.map((meal) => meal.mealSlot));
  const idBySlot = new Map(remainingMeals.map((meal) => [meal.mealSlot, meal.id]));
  const existingBySlot = new Map(remainingMeals.map((meal) => [meal.mealSlot, meal]));

  const candidates =
    typeof raw === "object" && raw && "meals" in raw && Array.isArray((raw as { meals?: unknown[] }).meals)
      ? ((raw as { meals: unknown[] }).meals ?? [])
      : [];

  const mapped: RewrittenMeal[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const mealSlot = (candidate as { mealSlot?: MealSlot }).mealSlot;
    if (!mealSlot || !slotSet.has(mealSlot)) {
      continue;
    }

    const existing = existingBySlot.get(mealSlot);
    if (!existing) {
      continue;
    }

    mapped.push({
      id: idBySlot.get(mealSlot) ?? existing.id,
      mealSlot,
      mealName: String((candidate as { mealName?: string }).mealName ?? existing.mealName).trim() || existing.mealName,
      portionText:
        String((candidate as { portionText?: string }).portionText ?? existing.portionText).trim() ||
        existing.portionText,
      calories: Math.max(50, Math.round(Number((candidate as { calories?: number }).calories ?? existing.plannedCalories))),
      protein: Math.max(0, Math.round(Number((candidate as { protein?: number }).protein ?? existing.plannedProtein))),
      carbs: Math.max(0, Math.round(Number((candidate as { carbs?: number }).carbs ?? existing.plannedCarbs))),
      fat: Math.max(0, Math.round(Number((candidate as { fat?: number }).fat ?? existing.plannedFat))),
    });
  }

  if (mapped.length !== remainingMeals.length) {
    throw new Error("Model did not return all remaining meal slots");
  }

  return remainingMeals.map((meal) => mapped.find((entry) => entry.mealSlot === meal.mealSlot)!).filter(Boolean);
}

export async function rewriteRemainingMeals(input: RewriteInput): Promise<RewrittenMeal[]> {
  if (input.remainingMeals.length === 0) {
    return [];
  }

  const currentRemainingTotals = sumTotals(input.remainingMeals);
  const desiredTotals: Totals = {
    calories: Math.max(0, input.calorieTarget),
    protein: Math.max(0, input.proteinTarget),
    carbs: Math.max(0, input.carbTarget),
    fat: Math.max(0, input.fatTarget),
  };

  const averageCalories = Math.round(desiredTotals.calories / input.remainingMeals.length);

  const prompt = `You are adjusting remaining meals for today.

Goal:
- Rewrite only the REMAINING meals in a practical, user-friendly way.
- Keep meals relatively similar to current meal ideas; mostly adjust portion sizes and small composition details.
- Do NOT invent a totally different plan unless absolutely necessary.
- Return strict JSON only.

User profile:
- dietary_preferences: ${input.preferences ?? "none"}
- allergies: ${input.allergies ?? "none"}
- dislikes: ${input.dislikes ?? "none"}
- skipped_meals: ${(input.skippedMealSlots ?? []).join(", ") || "none"}

Current remaining meals:
${input.remainingMeals
  .map(
    (meal) =>
      `- ${meal.mealSlot}: ${meal.mealName} | ${meal.portionText} | ${meal.plannedCalories} kcal | P ${meal.plannedProtein} C ${meal.plannedCarbs} F ${meal.plannedFat}`,
  )
  .join("\n")}

Current remaining totals:
- calories: ${currentRemainingTotals.calories}
- protein: ${currentRemainingTotals.protein}
- carbs: ${currentRemainingTotals.carbs}
- fat: ${currentRemainingTotals.fat}

Target remaining totals:
- calories: ${desiredTotals.calories}
- protein: ${desiredTotals.protein}
- carbs: ${desiredTotals.carbs}
- fat: ${desiredTotals.fat}
- average_calories_per_remaining_meal: ${averageCalories}

Rules:
1) Return exactly ${input.remainingMeals.length} meals with same mealSlot set: ${input.remainingMeals
    .map((meal) => meal.mealSlot)
    .join(", ")}.
2) Keep each meal recognizable vs its current version.
3) Use concrete portionText with grams or household measures.
4) Respect allergies/dislikes.
5) Keep total calories within +-75 of target and each macro within +-12g of target.

Output schema:
{
  "meals": [
    {
      "mealSlot": "lunch",
      "mealName": "string",
      "portionText": "string",
      "calories": 600,
      "protein": 35,
      "carbs": 70,
      "fat": 18
    }
  ],
  "summary": {
    "total_calories": 0,
    "total_protein": 0,
    "total_carbs": 0,
    "total_fat": 0,
    "average_calories": 0
  }
}`;
  const text = await generateTextWithConfiguredProvider(prompt);
  const parsed = parseModelJson<unknown>(text);
  return normalizeRewrittenMeals(parsed, input.remainingMeals);
}
