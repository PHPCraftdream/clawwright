/** Bytes as B/KiB/MiB/GiB/TiB (powers of 1024, labelled as such). */
export function humanSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
