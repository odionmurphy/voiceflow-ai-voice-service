import { DateTime } from "luxon";

/** Reads "YYYY-MM-DD" + "HH:mm" as wall-clock time in `timezone`; returns the real UTC instant. */
export function zonedToUtcDate(date: string, time: string, timezone: string): Date {
  return DateTime.fromISO(`${date}T${time}`, { zone: timezone }).toJSDate();
}

/** Formats an instant in the business's timezone (not the server's). */
export function formatInZone(value: Date | string, timezone: string, locale = "de"): string {
  const dt =
    typeof value === "string"
      ? DateTime.fromISO(value, { zone: timezone })
      : DateTime.fromJSDate(value, { zone: timezone });
  return dt
    .setLocale(locale)
    .toLocaleString({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}