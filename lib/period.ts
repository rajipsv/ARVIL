/**
 * Reporting windows shared by the dashboard, report and engineer console.
 * Kept free of DB imports so client components can use it.
 */

export const PERIOD_KEYS = ["7d", "30d", "90d", "all"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

/** "All time" is a window wide enough to cover every stored log. */
export const ALL_TIME_DAYS = 3650;

const PERIOD_DAYS: Record<PeriodKey, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: ALL_TIME_DAYS,
};

export function normalizePeriodKey(param: string | null | undefined): PeriodKey {
  const p = (param ?? "").trim().toLowerCase();
  if (p === "30d" || p === "30") return "30d";
  if (p === "90d" || p === "90") return "90d";
  if (p === "all") return "all";
  return "7d";
}

export function parsePeriodDays(param: string | null): number {
  return PERIOD_DAYS[normalizePeriodKey(param)];
}

export function periodKeyFromDays(days: number): PeriodKey {
  if (days >= ALL_TIME_DAYS) return "all";
  if (days === 90) return "90d";
  if (days === 30) return "30d";
  return "7d";
}

/** Button label, e.g. "7 days" or "All time". */
export function periodButtonLabel(key: PeriodKey): string {
  return key === "all" ? "All time" : `${PERIOD_DAYS[key]} days`;
}

/** Phrase for sentences, e.g. "the last 7 days" or "all time". */
export function periodPhrase(days: number): string {
  return days >= ALL_TIME_DAYS ? "all time" : `the last ${days} days`;
}

/** Heading form, e.g. "Last 7 days" or "All time". */
export function periodHeading(days: number): string {
  return days >= ALL_TIME_DAYS ? "All time" : `Last ${days} days`;
}
