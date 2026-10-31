// Which versions a site keeps (config.retention): every version from the last
// versionDays, the last version of each calendar month for monthEndMonths, and
// the current version whatever its age. Months are counted in the configured
// time zone, so a version made early on the 1st belongs to the month it was
// made in there.

export type VersionRetention = { versionDays: number; monthEndMonths: number; timeZone: string };

// "YYYY-MM" for a moment, in a time zone.
function monthOf(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

// The month n months before a "YYYY-MM" month.
function monthsBefore(month: string, n: number): string {
  const [year = 0, mon = 1] = month.split('-').map(Number);
  const index = year * 12 + (mon - 1) - n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function versionsToKeep(versions: { id: string; createdAt: string }[], current: string, now: Date, retention: VersionRetention): Set<string> {
  const keep = new Set([current]);
  const recent = now.getTime() - retention.versionDays * 86_400_000;
  // Months strictly after this one have their month-end version kept.
  const oldest = monthsBefore(monthOf(now, retention.timeZone), retention.monthEndMonths);
  const lastOfMonth = new Map<string, { id: string; at: string }>();
  for (const v of versions) {
    if (Date.parse(v.createdAt) >= recent) keep.add(v.id);
    const month = monthOf(new Date(v.createdAt), retention.timeZone);
    const last = lastOfMonth.get(month);
    if (!last || v.createdAt > last.at || (v.createdAt === last.at && v.id > last.id)) lastOfMonth.set(month, { id: v.id, at: v.createdAt });
  }
  for (const [month, { id }] of lastOfMonth) if (month > oldest) keep.add(id);
  return keep;
}
