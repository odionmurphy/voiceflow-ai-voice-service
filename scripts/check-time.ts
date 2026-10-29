import { zonedToUtcDate } from "../src/utils/time";

for (const d of ["2026-11-02", "2026-07-06"]) {
  console.log(d, "15:00 Berlin ->", zonedToUtcDate(d, "15:00", "Europe/Berlin").toISOString());
}
