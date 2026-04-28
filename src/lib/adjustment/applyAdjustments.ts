import { MealSlot } from "@prisma/client";

type MealTotals = {
  plannedCalories: number;
  plannedProtein: number;
  plannedCarbs: number;
  plannedFat: number;
};

type RemainingMeal = {
  id: string;
  mealSlot: MealSlot;
  totals: MealTotals;
};

type Delta = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type AdjustmentResult = {
  applied: Array<{
    plannedMealId: string;
    mealSlot: MealSlot;
    calorieDelta: number;
    newCalories: number;
    newProtein: number;
    newCarbs: number;
    newFat: number;
    proteinDelta: number;
    carbDelta: number;
    fatDelta: number;
  }>;
};

const MIN_MEAL_CALORIES = 250;

function allocateProportional(totalDelta: number, bases: number[]): number[] {
  const count = bases.length;
  if (count === 0 || totalDelta === 0) {
    return Array.from({ length: count }, () => 0);
  }

  const baseSum = bases.reduce((sum, value) => sum + Math.max(0, value), 0);
  const weights =
    baseSum > 0
      ? bases.map((value) => Math.max(0, value) / baseSum)
      : Array.from({ length: count }, () => 1 / count);

  const rawShares = weights.map((weight) => totalDelta * weight);
  const shares = rawShares.map((value) => (value < 0 ? Math.ceil(value) : Math.floor(value)));
  let remainder = totalDelta - shares.reduce((sum, value) => sum + value, 0);

  if (remainder === 0) {
    return shares;
  }

  const sortedIndices = rawShares
    .map((value, index) => ({ index, fraction: Math.abs(value - shares[index]) }))
    .sort((a, b) => b.fraction - a.fraction)
    .map((entry) => entry.index);

  let cursor = 0;
  while (remainder !== 0 && sortedIndices.length > 0) {
    const index = sortedIndices[cursor % sortedIndices.length];
    shares[index] += remainder > 0 ? 1 : -1;
    remainder += remainder > 0 ? -1 : 1;
    cursor += 1;
  }

  return shares;
}

export function applyAdjustments(remainingMeals: RemainingMeal[], delta: Delta): AdjustmentResult {
  if (remainingMeals.length === 0) {
    return { applied: [] };
  }

  if (delta.calories === 0 && delta.protein === 0 && delta.carbs === 0 && delta.fat === 0) {
    return { applied: [] };
  }

  const calorieBases = remainingMeals.map((meal) => meal.totals.plannedCalories);
  const proteinBases = remainingMeals.map((meal) => meal.totals.plannedProtein);
  const carbBases = remainingMeals.map((meal) => meal.totals.plannedCarbs);
  const fatBases = remainingMeals.map((meal) => meal.totals.plannedFat);

  const calorieShares = allocateProportional(delta.calories, calorieBases);
  const proteinShares = allocateProportional(delta.protein, proteinBases);
  const carbShares = allocateProportional(delta.carbs, carbBases);
  const fatShares = allocateProportional(delta.fat, fatBases);

  // Enforce minimum calories when reducing remaining meals after overeating.
  if (delta.calories > 0) {
    const cappedShares = [...calorieShares];
    for (let i = 0; i < remainingMeals.length; i += 1) {
      const maxReduction = Math.max(0, remainingMeals[i].totals.plannedCalories - MIN_MEAL_CALORIES);
      if (cappedShares[i] > maxReduction) {
        cappedShares[i] = maxReduction;
      }
    }

    let unmet = delta.calories - cappedShares.reduce((sum, value) => sum + value, 0);
    while (unmet > 0) {
      const capacities = remainingMeals.map((meal, i) => {
        const maxReduction = Math.max(0, meal.totals.plannedCalories - MIN_MEAL_CALORIES);
        return Math.max(0, maxReduction - cappedShares[i]);
      });

      const capacityTotal = capacities.reduce((sum, value) => sum + value, 0);
      if (capacityTotal <= 0) {
        break;
      }

      const extraShares = allocateProportional(unmet, capacities);
      let assigned = 0;
      for (let i = 0; i < cappedShares.length; i += 1) {
        const allowed = Math.min(extraShares[i], capacities[i]);
        if (allowed > 0) {
          cappedShares[i] += allowed;
          assigned += allowed;
        }
      }

      if (assigned <= 0) {
        break;
      }
      unmet -= assigned;
    }

    for (let i = 0; i < calorieShares.length; i += 1) {
      calorieShares[i] = cappedShares[i];
    }
  }

  const applied = remainingMeals.map((meal, index) => {
    const calorieShare = calorieShares[index];
    const proteinShare = proteinShares[index];
    const carbShare = carbShares[index];
    const fatShare = fatShares[index];

    const newCalories = Math.max(MIN_MEAL_CALORIES, meal.totals.plannedCalories - calorieShare);
    const newProtein = Math.max(0, meal.totals.plannedProtein - proteinShare);
    const newCarbs = Math.max(0, meal.totals.plannedCarbs - carbShare);
    const newFat = Math.max(0, meal.totals.plannedFat - fatShare);

    const calorieDelta = newCalories - meal.totals.plannedCalories;
    const proteinDelta = newProtein - meal.totals.plannedProtein;
    const carbDelta = newCarbs - meal.totals.plannedCarbs;
    const fatDelta = newFat - meal.totals.plannedFat;

    return {
      plannedMealId: meal.id,
      mealSlot: meal.mealSlot,
      calorieDelta,
      newCalories,
      newProtein,
      newCarbs,
      newFat,
      proteinDelta,
      carbDelta,
      fatDelta,
    };
  });

  return { applied };
}
