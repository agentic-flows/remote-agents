/**
 * Timezone/date utilities
 * 
 * Converts a local time string to UTC.
 * Example: "2026-01-16T13:00:00" in America/Chicago (UTC-6) -> "2026-01-16T19:00:00.000Z"
 */

export function toUtcISOString(localIso: string, timeZone: string): string {
  // Parse the local datetime components
  const [datePart, timePart] = localIso.split('T');
  if (!datePart || !timePart) {
    return localIso.endsWith('Z') ? localIso : `${localIso}Z`;
  }

  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute = 0, second = 0] = timePart.split(':').map(n => parseInt(n, 10));

  // Get the UTC offset for this timezone at this date/time
  // Create a date in UTC with these values
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  
  // Format that UTC date in the target timezone to see what local time it represents
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  
  const parts = formatter.formatToParts(utcDate);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  
  const localYear = get('year');
  const localMonth = get('month');
  const localDay = get('day');
  const localHour = get('hour');
  const localMinute = get('minute');
  const localSecond = get('second');
  
  // The offset is: local time - UTC time (in milliseconds)
  const localAsUtc = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond));
  const offsetMs = localAsUtc.getTime() - utcDate.getTime();
  
  // To convert local -> UTC, we need to subtract the offset
  // If timezone is UTC-6 (Chicago), offset is -6 hours (-21600000 ms)
  // local 13:00 - (-6 hours) = 13:00 + 6 hours = 19:00 UTC
  const targetUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs);
  
  return targetUtc.toISOString();
}
