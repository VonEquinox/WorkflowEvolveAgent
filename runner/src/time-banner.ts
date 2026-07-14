/**
 * Wall-clock time banner for agent prompts.
 * Pure helpers — inject at send time only (not into cache keys).
 */

/** Local ISO-8601 with timezone offset, e.g. 2026-07-14T22:15:30+08:00 */
export function formatWeaNow(date: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	const y = date.getFullYear();
	const m = pad(date.getMonth() + 1);
	const d = pad(date.getDate());
	const h = pad(date.getHours());
	const min = pad(date.getMinutes());
	const s = pad(date.getSeconds());
	// getTimezoneOffset is minutes to add to local to get UTC (inverted sign).
	const totalMin = -date.getTimezoneOffset();
	const sign = totalMin >= 0 ? "+" : "-";
	const abs = Math.abs(totalMin);
	const oh = pad(Math.floor(abs / 60));
	const om = pad(abs % 60);
	return `${y}-${m}-${d}T${h}:${min}:${s}${sign}${oh}:${om}`;
}

/** Prepend a short stable current-time banner to text. */
export function withCurrentTime(text: string, date: Date = new Date()): string {
	return `[Current time: ${formatWeaNow(date)}]\n\n${text}`;
}
