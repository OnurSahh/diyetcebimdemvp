import { ActivityLevel, Goal, PortionComfortLevel } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { calculateTargets } from "@/lib/nutrition/targets";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/requireUser";

const schema = z.object({
  age: z.number().int().min(14).max(100),
  sexGender: z.string().min(2),
  heightCm: z.number().min(120).max(250),
  weightKg: z.number().min(35).max(300),
  activityLevel: z.nativeEnum(ActivityLevel),
  goal: z.nativeEnum(Goal),
  preferences: z.string().optional(),
  allergies: z.string().optional(),
  dislikes: z.string().optional(),
  edHistoryFlag: z.boolean(),
  edTriggerNotes: z.string().optional(),
  portionComfort: z.nativeEnum(PortionComfortLevel),
});

export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const targets = calculateTargets({
      age: parsed.data.age,
      sexGender: parsed.data.sexGender,
      heightCm: parsed.data.heightCm,
      weightKg: parsed.data.weightKg,
      activityLevel: parsed.data.activityLevel,
      goal: parsed.data.goal,
    });

    const updated = await prisma.user.update({
      where: { id: user!.id },
      data: {
        age: parsed.data.age,
        sexGender: parsed.data.sexGender,
        heightCm: parsed.data.heightCm,
        weightKg: parsed.data.weightKg,
        activityLevel: parsed.data.activityLevel,
        goal: parsed.data.goal,
        preferences: parsed.data.preferences || null,
        allergies: parsed.data.allergies || null,
        dislikes: parsed.data.dislikes || null,
        edHistoryFlag: parsed.data.edHistoryFlag,
        edTriggerNotes: parsed.data.edTriggerNotes || null,
        portionComfort: parsed.data.portionComfort,
        calorieTarget: targets.calorieTarget,
        macroProteinTarget: targets.proteinTarget,
        macroCarbTarget: targets.carbTarget,
        macroFatTarget: targets.fatTarget,
      },
      select: {
        id: true,
        email: true,
        calorieTarget: true,
        macroProteinTarget: true,
        macroCarbTarget: true,
        macroFatTarget: true,
        edHistoryFlag: true,
      },
    });

    return NextResponse.json({ user: updated, targets });
  } catch {
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
