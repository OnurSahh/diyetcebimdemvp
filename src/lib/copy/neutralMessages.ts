import { ComparisonResult } from "@prisma/client";

export function comparisonMessage(result: ComparisonResult): string {
  if (result === "match") {
    return "Looks close to your plan.";
  }
  if (result === "less") {
    return "This meal looks smaller than planned.";
  }
  if (result === "more") {
    return "This meal looks larger than planned.";
  }
  return "This looks different from the planned meal.";
}

export function adjustmentSummary(deltaCalories: number): string {
  if (deltaCalories === 0) {
    return "No changes were needed for the rest of today.";
  }
  if (deltaCalories > 0) {
    return `We adjusted later meals to keep the day balanced after about +${deltaCalories} kcal.`;
  }
  return `We adjusted later meals to keep the day balanced after about ${deltaCalories} kcal.`;
}
