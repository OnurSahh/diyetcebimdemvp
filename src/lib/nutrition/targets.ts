import { ActivityLevel, Goal } from "@prisma/client";

export type TargetInput = {
  age: number;
  sexGender: string;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
};

export type TargetOutput = {
  bmr: number;
  tdee: number;
  calorieTarget: number;
  proteinTarget: number;
  carbTarget: number;
  fatTarget: number;
};

const activityMultiplierMap: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const goalOffsetMap: Record<Goal, number> = {
  maintain: 0,
  cut: -350,
  bulk: 250,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function calculateTargets(input: TargetInput): TargetOutput {
  const { age, sexGender, heightCm, weightKg, activityLevel, goal } = input;
  const normalizedSex = sexGender.toLowerCase();
  const sexOffset = normalizedSex.includes("male") ? 5 : -161;

  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
  const tdee = bmr * activityMultiplierMap[activityLevel];
  const calorieTarget = clamp(Math.round(tdee + goalOffsetMap[goal]), 1200, 4000);

  // Default macro split: protein 30%, fat 30%, carbs 40%
  const proteinTarget = Math.round((calorieTarget * 0.3) / 4);
  const fatTarget = Math.round((calorieTarget * 0.3) / 9);
  const carbTarget = Math.round((calorieTarget * 0.4) / 4);

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calorieTarget,
    proteinTarget,
    carbTarget,
    fatTarget,
  };
}
