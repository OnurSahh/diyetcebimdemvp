import { MealSlot } from "@prisma/client";
import { generateTextWithConfiguredProvider } from "@/lib/ai/textProvider";

export type GeneratedMeal = {
  mealSlot: MealSlot;
  mealName: string;
  portionText: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type GenerateInput = {
  calorieTarget: number;
  proteinTarget: number;
  carbTarget: number;
  fatTarget: number;
  preferences?: string | null;
  allergies?: string | null;
  dislikes?: string | null;
  edHistoryFlag?: boolean;
};

type GeneratedResponse = {
  meals: GeneratedMeal[];
};

const mealSlots: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

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

function normalizePlan(rawMeals: Partial<GeneratedMeal>[]): GeneratedMeal[] {
  if (!Array.isArray(rawMeals) || rawMeals.length === 0) {
    throw new Error("Model did not return meals");
  }

  const bySlot = new Map<MealSlot, GeneratedMeal>();

  for (const candidate of rawMeals) {
    if (!candidate.mealSlot || !mealSlots.includes(candidate.mealSlot)) {
      continue;
    }

    if (
      !candidate.mealName ||
      !candidate.portionText ||
      candidate.calories == null ||
      candidate.protein == null ||
      candidate.carbs == null ||
      candidate.fat == null
    ) {
      continue;
    }

    bySlot.set(candidate.mealSlot, {
      mealSlot: candidate.mealSlot,
      mealName: candidate.mealName,
      portionText: candidate.portionText,
      calories: Math.max(50, Math.round(candidate.calories)),
      protein: Math.max(0, Math.round(candidate.protein)),
      carbs: Math.max(0, Math.round(candidate.carbs)),
      fat: Math.max(0, Math.round(candidate.fat)),
    });
  }

  const meals = mealSlots.map((slot) => bySlot.get(slot)).filter(Boolean) as GeneratedMeal[];
  if (meals.length !== 4) {
    throw new Error("Model response did not include all meal slots");
  }

  return meals;
}

export async function generateDailyPlan(input: GenerateInput): Promise<GeneratedResponse> {
  const prompt = `You are generating a one-day meal plan.

Return strict JSON only. No markdown and no code fences.

User profile:
- target_calories: ${input.calorieTarget}
- target_protein_g: ${input.proteinTarget}
- target_carbs_g: ${input.carbTarget}
- target_fat_g: ${input.fatTarget}
- dietary_preferences: ${input.preferences ?? "none"}
- allergies: ${input.allergies ?? "none"}
- dislikes: ${input.dislikes ?? "none"}
- ed_aware: ${input.edHistoryFlag ? "true" : "false"}

Hard constraints:
1) Generate exactly four meals with these slots: breakfast, lunch, dinner, snack.
2) Do not use restricted foods (allergies/dislikes).
3) Keep daily totals near targets (within about 8%).
4) Use realistic, repeatable meals.
5) portionText must be actionable with units in grams or household measures (tablespoons, cups, bowls, slices, pieces).
6) Keep wording neutral and practical.

Output schema:
{
  "meals": [
    {
      "mealSlot": "breakfast",
      "mealName": "string",
      "portionText": "string with concrete amounts e.g. 180g yogurt + 40g oats (about 4 tbsp)",
      "calories": 500,
      "protein": 35,
      "carbs": 55,
      "fat": 18
    }
  ]
}`;

  const text = await generateTextWithConfiguredProvider(prompt);
  const parsed = parseModelJson<{ meals?: Partial<GeneratedMeal>[] }>(text);
  return { meals: normalizePlan(parsed.meals ?? []) };
}
