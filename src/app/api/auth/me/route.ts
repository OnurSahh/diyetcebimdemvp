import { NextResponse } from "next/server";

import { requireUser } from "@/lib/requireUser";

export async function GET() {
  const { user, response } = await requireUser();
  if (response) {
    return response;
  }

  return NextResponse.json({
    user: {
      id: user!.id,
      email: user!.email,
      calorieTarget: user!.calorieTarget,
      macroProteinTarget: user!.macroProteinTarget,
      macroCarbTarget: user!.macroCarbTarget,
      macroFatTarget: user!.macroFatTarget,
      edHistoryFlag: user!.edHistoryFlag,
    },
  });
}
