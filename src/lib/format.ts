export function displayTime(date: Date): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (dateStart.getTime() === todayStart.getTime()) {
    return `Today at ${timeStr}`;
  }

  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  if (dateStart.getTime() === yesterdayStart.getTime()) {
    return `Yesterday at ${timeStr}`;
  }

  const monthName = date.toLocaleString('en-US', { month: 'long' });
  return `${monthName} ${date.getDate()} at ${timeStr}`;
}

export function fuelGradeDisplay(grade: string): { code: string; display: string } {
  switch (grade) {
    case 'GASOLINE_91': return { code: 'GASOLINE_91', display: 'Gasoline 91' };
    case 'GASOLINE_95': return { code: 'GASOLINE_95', display: 'Gasoline 95' };
    case 'DIESEL':      return { code: 'DIESEL',      display: 'Diesel' };
    default:            return { code: grade,          display: grade };
  }
}

export function gradeColorHint(grade: string): { background: string; foreground: string; name: string } {
  switch (grade) {
    case 'GASOLINE_91': return { background: '#1C3A5E', foreground: '#FFFFFF', name: 'Navy' };
    case 'GASOLINE_95': return { background: '#FF9F0A', foreground: '#000000', name: 'Amber Gold' };
    case 'DIESEL':      return { background: '#30D158', foreground: '#000000', name: 'Green' };
    default:            return { background: '#8E8E93', foreground: '#FFFFFF', name: 'Gray' };
  }
}

export function sarDisplay(halalas: bigint): string {
  const sign = halalas < 0n ? '-' : '';
  const abs = halalas < 0n ? -halalas : halalas;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${cents}`;
}

let fillCounter = 0;
export function fillReference(date: Date): string {
  fillCounter = (fillCounter + 1) % 10000;
  const dateStr = date.toISOString().slice(0, 10);
  return `FILL-${dateStr}-${fillCounter.toString().padStart(4, '0')}`;
}
