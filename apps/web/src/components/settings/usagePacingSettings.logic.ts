import { DEFAULT_WORK_HOURS, formatWorkHours, parseWorkHours } from "@t3tools/shared/usagePacing";

const TIME_INPUT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function minutesToTimeInput(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

function timeInputToMinutes(value: string): number | null {
  const match = TIME_INPUT_PATTERN.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Stored "HH:MM-HH:MM" -> values for two `<input type="time">`. A malformed value shows the default
 * hours. An end of 24:00 is shown as "00:00" because a time input cannot hold 24:00.
 */
export function workHoursToTimeInputs(value: string): { start: string; end: string } {
  const hours = parseWorkHours(value) ?? parseWorkHours(DEFAULT_WORK_HOURS);
  if (!hours) return { start: "09:00", end: "17:00" };
  return { start: minutesToTimeInput(hours.startMin), end: minutesToTimeInput(hours.endMin) };
}

/** Two time-input values -> stored string, or null when either is empty or malformed. */
export function workHoursFromTimeInputs(start: string, end: string): string | null {
  const startMin = timeInputToMinutes(start);
  const endMin = timeInputToMinutes(end);
  if (startMin === null || endMin === null) return null;
  return formatWorkHours({ startMin, endMin: endMin === 0 ? 1440 : endMin });
}

/** Clamp to 0..1 and snap to the nearest 0.05; null for a non-finite input. */
export function snapOffHoursWeight(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 20) / 20;
}

/** Set equality: order and duplicates ignored. */
export function sameWorkDays(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((day) => right.has(day));
}
