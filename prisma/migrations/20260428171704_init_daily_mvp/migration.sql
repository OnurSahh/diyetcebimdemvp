-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "age" INTEGER,
    "sexGender" TEXT,
    "heightCm" REAL,
    "weightKg" REAL,
    "activityLevel" TEXT,
    "goal" TEXT,
    "preferences" TEXT,
    "allergies" TEXT,
    "dislikes" TEXT,
    "edHistoryFlag" BOOLEAN NOT NULL DEFAULT false,
    "edTriggerNotes" TEXT,
    "portionComfort" TEXT,
    "calorieTarget" INTEGER,
    "macroProteinTarget" INTEGER,
    "macroCarbTarget" INTEGER,
    "macroFatTarget" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DailyPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalTargetCalories" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DailyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlannedMeal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dailyPlanId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "mealSlot" TEXT NOT NULL,
    "mealName" TEXT NOT NULL,
    "portionText" TEXT NOT NULL,
    "plannedCalories" INTEGER NOT NULL,
    "plannedProtein" INTEGER NOT NULL,
    "plannedCarbs" INTEGER NOT NULL,
    "plannedFat" INTEGER NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlannedMeal_dailyPlanId_fkey" FOREIGN KEY ("dailyPlanId") REFERENCES "DailyPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "plannedMealId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "mealSlot" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "actualCalories" INTEGER NOT NULL,
    "actualProtein" INTEGER NOT NULL,
    "actualCarbs" INTEGER NOT NULL,
    "actualFat" INTEGER NOT NULL,
    "comparisonResult" TEXT NOT NULL,
    "confidence" REAL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MealLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MealLog_plannedMealId_fkey" FOREIGN KEY ("plannedMealId") REFERENCES "PlannedMeal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Adjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "triggeredByMealLogId" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "calorieDelta" INTEGER NOT NULL,
    "macroDeltaJson" TEXT NOT NULL,
    "appliedToMealsJson" TEXT NOT NULL,
    "acceptedFlag" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Adjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Adjustment_triggeredByMealLogId_fkey" FOREIGN KEY ("triggeredByMealLogId") REFERENCES "MealLog" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_userId_date_key" ON "DailyPlan"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedMeal_dailyPlanId_mealSlot_key" ON "PlannedMeal"("dailyPlanId", "mealSlot");

-- CreateIndex
CREATE INDEX "MealLog_userId_date_idx" ON "MealLog"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Adjustment_triggeredByMealLogId_key" ON "Adjustment"("triggeredByMealLogId");

-- CreateIndex
CREATE INDEX "Adjustment_userId_date_idx" ON "Adjustment"("userId", "date");
