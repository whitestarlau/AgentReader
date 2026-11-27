/** 渲染层通用格式化：字节数、时间、下载速度。 */

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} KB`;
	return `${Math.round(n)} B`;
}

export function formatSpeed(bytesPerSecond: number): string {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
	return `${formatBytes(bytesPerSecond)}/s`;
}

/** 毫秒时间戳 → "11 月 20 日 22:24"；无效值显示“从未”。 */
export function formatDateTime(ms: number | null | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "从未";
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "从未";
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hh}:${mm}`;
}

/** ISO 时间 → "2026-11-20"；用于展示 Release 发布日期。 */
export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
		date.getDate(),
	).padStart(2, "0")}`;
}
