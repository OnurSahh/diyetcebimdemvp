import { ComparisonResult } from "@prisma/client";

type CompareInput = {
  plannedCalories: number;
  actualCalories: number;
  isDifferentMeal: boolean;
};

export function classifyMealComparison(input: CompareInput): ComparisonResult {
  const { plannedCalories, actualCalories, isDifferentMeal } = input;

  if (isDifferentMeal) {
    return "different";
  }

  const delta = actualCalories - plannedCalories;
  const tolerance = Math.max(75, Math.round(plannedCalories * 0.1));

  if (Math.abs(delta) <= tolerance) {
    return "match";
  }

  return delta > 0 ? "more" : "less";
}
