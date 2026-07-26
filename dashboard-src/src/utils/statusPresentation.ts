export type StatusTone = "green" | "yellow" | "gray" | "red" | "blue";

const tones: StatusTone[] = ["blue", "green", "yellow", "red", "gray"];

export function statusTone(value: unknown): StatusTone {
  const status = typeof value === "string" ? value : "";
  let hash = 0;
  for (let index = 0; index < status.length; index += 1) {
    hash = ((hash * 31) + status.charCodeAt(index)) >>> 0;
  }
  return tones[hash % tones.length];
}

export function statusLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  return value.replace(/[_-]+/g, " ");
}

export function statusStyle(value: unknown): { color: string; bg: string } {
  return {
    blue: { color: "#60a5fa", bg: "#1e3a5f" },
    green: { color: "#4ade80", bg: "#0d3320" },
    yellow: { color: "#fbbf24", bg: "#3d3d00" },
    red: { color: "#f87171", bg: "#3d1515" },
    gray: { color: "#9ca3af", bg: "#1f1f1f" },
  }[statusTone(value)];
}

export function statusCounts<T>(
  items: T[],
  select: (item: T) => unknown,
): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const raw = select(item);
    const status = typeof raw === "string" && raw.trim() ? raw : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}
