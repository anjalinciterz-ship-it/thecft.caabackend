import { env } from '../config/env.js';

// The Wisdom Call repeats on a rule, so its dates are derived rather than
// stored: nothing has to be added each month, and a passed date disappears on
// its own. A row is only written when a member registers.
export const WISDOM_CALL = 'wednesday_wisdom_call';

const series = {
  [WISDOM_CALL]: {
    id: WISDOM_CALL,
    title: 'Wednesday Wisdom Call',
    description:
      'A free weekly live session led by Zalah. Pause, consider a new perspective and ask your questions in the room.',
    weekday: 'Wednesday',
    hour: env.WISDOM_CALL_HOUR,
    minute: env.WISDOM_CALL_MINUTE,
    timeZone: env.WISDOM_CALL_TIMEZONE,
    registrationRequired: true
  }
};

export const seriesFor = (key) => series[key] || null;
export const allSeries = () => Object.values(series);

const zoneParts = (instant, timeZone) => {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long'
  }).formatToParts(new Date(instant));
  const read = (type) => values.find((part) => part.type === type)?.value;
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    weekday: read('weekday')
  };
};

// A wall clock in the class's own zone, resolved to a real instant. The first
// pass assumes the zone is UTC, then each pass re-reads the offset at the
// instant found so far and re-anchors from the wall time itself, which is what
// makes a DST boundary inside the month land on the right day.
function instantAtWall(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = zoneParts(utc, timeZone);
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - utc;
    const next = wall - offset;
    if (next === utc) break;
    utc = next;
  }
  return utc;
}

const pad = (n) => String(n).padStart(2, '0');

export const occurrenceId = (seriesId, year, month, day) => `${seriesId}-${year}-${pad(month)}-${pad(day)}`;

const parseOccurrenceId = (id) => {
  const match = /^(.+)-(\d{4})-(\d{2})-(\d{2})$/.exec(String(id || ''));
  if (!match) return null;
  const definition = seriesFor(match[1]);
  if (!definition) return null;
  return { definition, year: Number(match[2]), month: Number(match[3]), day: Number(match[4]) };
};

function occurrencesInMonth(definition, year, month) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const found = [];
  for (let day = 1; day <= days; day += 1) {
    const start = instantAtWall(year, month, day, definition.hour, definition.minute, definition.timeZone);
    const parts = zoneParts(start, definition.timeZone);
    // A wall time that lands in the neighbouring month (or reads as the wrong
    // weekday because the zone shifted the clock) is not one of this month's.
    if (parts.month !== month || parts.weekday !== definition.weekday) continue;
    found.push({
      id: occurrenceId(definition.id, year, month, day),
      series: definition.id,
      title: definition.title,
      description: definition.description,
      startAt: new Date(start).toISOString(),
      timeZone: definition.timeZone,
      registrationRequired: definition.registrationRequired,
      registrationOpen: true,
      status: 'scheduled'
    });
  }
  return found;
}

/**
 * The member sees the class dates still to come in the month the call itself
 * is held in, so December takes over on its own once the last November
 * Wednesday has passed.
 */
export function upcomingOccurrences(now = new Date()) {
  const out = [];
  for (const definition of allSeries()) {
    const here = zoneParts(now.getTime(), definition.timeZone);
    for (const item of occurrencesInMonth(definition, here.year, here.month)) {
      if (new Date(item.startAt) > now) out.push(item);
    }
  }
  return out.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

export function pastOccurrences(now = new Date()) {
  const out = [];
  for (const definition of allSeries()) {
    const here = zoneParts(now.getTime(), definition.timeZone);
    const previous = here.month === 1 ? { year: here.year - 1, month: 12 } : { year: here.year, month: here.month - 1 };
    for (const month of [previous, here]) {
      for (const item of occurrencesInMonth(definition, month.year, month.month)) {
        if (new Date(item.startAt) <= now) out.push(item);
      }
    }
  }
  return out.sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
}

export function findOccurrence(id, now = new Date()) {
  const parsed = parseOccurrenceId(id);
  if (!parsed) return null;
  const { definition, year, month, day } = parsed;
  const start = instantAtWall(year, month, day, definition.hour, definition.minute, definition.timeZone);
  const parts = zoneParts(start, definition.timeZone);
  if (parts.month !== month || parts.day !== day || parts.weekday !== definition.weekday) return null;
  return {
    id,
    series: definition.id,
    title: definition.title,
    description: definition.description,
    startAt: new Date(start).toISOString(),
    timeZone: definition.timeZone,
    registrationRequired: definition.registrationRequired,
    registrationOpen: new Date(start) > now,
    status: new Date(start) > now ? 'scheduled' : 'completed'
  };
}
