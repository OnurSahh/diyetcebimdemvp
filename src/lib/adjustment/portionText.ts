const ADJUSTMENT_MARKER = " | Adjusted plan:";

function basePortionText(value: string): string {
  return value.split(ADJUSTMENT_MARKER)[0].trim();
}

const SCALABLE_UNITS = [
  "g",
  "kg",
  "ml",
  "l",
  "tbsp",
  "tsp",
  "cup",
  "cups",
  "bowl",
  "bowls",
  "slice",
  "slices",
  "piece",
  "pieces",
] as const;

function roundScaledValue(value: number, unit: string): number {
  if (["g", "ml"].includes(unit)) {
    return Math.max(1, Math.round(value / 5) * 5);
  }

  if (unit === "kg" || unit === "l") {
    return Math.max(0.1, Math.round(value * 10) / 10);
  }

  if (["tbsp", "tsp", "cup", "cups", "bowl", "bowls"].includes(unit)) {
    return Math.max(0.25, Math.round(value * 4) / 4);
  }

  return Math.max(0.5, Math.round(value * 2) / 2);
}

function formatScaledValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, "");
}

function scalePortionText(value: string, ratio: number): string {
  let replacements = 0;

  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?)(\\s*)(${SCALABLE_UNITS.join("|")})\\b`, "gi");
  const scaled = value.replace(pattern, (match, rawNumber: string, spacer: string, unitRaw: string) => {
    const original = Number(rawNumber);
    if (!Number.isFinite(original)) {
      return match;
    }

    const unit = unitRaw.toLowerCase();
    const scaledNumber = roundScaledValue(original * ratio, unit);
    replacements += 1;
    return `${formatScaledValue(scaledNumber)}${spacer}${unitRaw}`;
  });

  if (replacements > 0) {
    return scaled;
  }

  return value;
}

export function withPortionAdjustmentNote(params: {
  originalPortionText: string;
  oldCalories: number;
  newCalories: number;
}): string {
  const { originalPortionText, oldCalories, newCalories } = params;
  const base = basePortionText(originalPortionText);

  if (oldCalories <= 0) {
    return base;
  }

  const ratio = newCalories / oldCalories;
  const percent = Math.round(Math.abs((ratio - 1) * 100));

  if (percent < 8) {
    return base;
  }

  const scaledPortionText = scalePortionText(base, ratio);

  const direction = ratio > 1 ? "increase" : "decrease";
  let note = `${ADJUSTMENT_MARKER} ${direction} portion by about ${percent}% with updated amounts.`;

  if (ratio > 1.45) {
    note += " If easier, split this into 2 smaller sittings.";
  }

  if (ratio > 1.75) {
    note += " You may also add 1 mini snack for comfort.";
  }

  return `${scaledPortionText}${note}`;
}
