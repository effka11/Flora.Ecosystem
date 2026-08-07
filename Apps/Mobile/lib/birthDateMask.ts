const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const BIRTH_YEAR_MIN = 1900;
const BIRTH_YEAR_MAX = 2100;

function getTodayLocal(referenceDate = new Date()): { year: number; month: number; day: number } {
  return {
    year: referenceDate.getFullYear(),
    month: referenceDate.getMonth() + 1,
    day: referenceDate.getDate(),
  };
}

export function getBirthDateMaxIso(referenceDate = new Date()): string {
  const today = getTodayLocal(referenceDate);
  return `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
}

function isDateNotAfterToday(
  day: number,
  month: number,
  year: number,
  referenceDate = new Date(),
): boolean {
  const today = getTodayLocal(referenceDate);
  if (year > today.year) return false;
  if (year < today.year) return true;
  if (month > today.month) return false;
  if (month < today.month) return true;
  return day <= today.day;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isYearPrefixAllowed(prefix: string, referenceDate = new Date()): boolean {
  if (!prefix.length) return true;
  const maxYear = getTodayLocal(referenceDate).year;
  for (let year = BIRTH_YEAR_MIN; year <= maxYear; year++) {
    if (String(year).startsWith(prefix)) return true;
  }
  return false;
}

function isPartialBirthDateNotInFuture(digits: string, referenceDate = new Date()): boolean {
  if (digits.length < 4) return true;

  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const yearDigits = digits.slice(4);
  const today = getTodayLocal(referenceDate);

  if (yearDigits.length === 4) {
    const year = Number(yearDigits);
    if (year > today.year) return false;
    return isDateNotAfterToday(day, month, year, referenceDate);
  }

  if (!yearDigits.length) return true;

  for (let year = BIRTH_YEAR_MIN; year <= today.year; year++) {
    if (!String(year).startsWith(yearDigits)) continue;
    if (isDateNotAfterToday(day, month, year, referenceDate)) return true;
  }

  return false;
}

function maxDayForMonth(month: number, yearDigits: string, referenceDate = new Date()): number {
  if (month < 1 || month > 12) return 0;

  let maxDay: number;
  if (month === 2) {
    if (yearDigits.length === 4) {
      const year = Number(yearDigits);
      if (year >= BIRTH_YEAR_MIN && year <= BIRTH_YEAR_MAX) {
        maxDay = isLeapYear(year) ? 29 : 28;
      } else {
        maxDay = 28;
      }
    } else {
      // Год ещё не введён: февраль не длиннее 28, чтобы не допустить 29.02 до високосного года.
      maxDay = 28;
    }
  } else {
    maxDay = DAYS_IN_MONTH[month - 1];
  }

  if (yearDigits.length === 4) {
    const year = Number(yearDigits);
    const today = getTodayLocal(referenceDate);
    if (year === today.year && month === today.month) {
      maxDay = Math.min(maxDay, today.day);
    }
  }

  return maxDay;
}

function isPartialBirthDateValid(digits: string): boolean {
  if (digits.length < 4) return true;

  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const yearDigits = digits.slice(4);

  if (month < 1 || month > 12 || day < 1) return false;
  if (day > maxDayForMonth(month, yearDigits)) return false;
  if (yearDigits.length > 0 && !isYearPrefixAllowed(yearDigits)) return false;
  if (!isPartialBirthDateNotInFuture(digits)) return false;
  if (digits.length === 8) return birthDateDigitsToIso(digits) !== null;

  return true;
}

/** Можно ли дописать цифру к уже введённой части DDMMYYYY. */
export function isBirthDateDigitAllowed(partialDigits: string, digit: string): boolean {
  if (!/^\d$/.test(digit)) return false;

  const pos = partialDigits.length;
  if (pos >= 8) return false;

  switch (pos) {
    case 0:
      if (!"0123".includes(digit)) return false;
      break;
    case 1: {
      const dayTens = partialDigits[0];
      if (dayTens === "0" && digit === "0") return false;
      if (dayTens === "3" && !"01".includes(digit)) return false;
      break;
    }
    case 2:
      if (!"01".includes(digit)) return false;
      break;
    case 3: {
      const monthTens = partialDigits[2];
      if (monthTens === "0" && !"123456789".includes(digit)) return false;
      if (monthTens === "1" && !"012".includes(digit)) return false;
      break;
    }
    default:
      break;
  }

  const next = partialDigits + digit;
  return isPartialBirthDateValid(next);
}

function filterBirthDateDigitsForward(raw: string): string {
  let result = "";
  for (const ch of raw) {
    if (!isBirthDateDigitAllowed(result, ch)) break;
    result += ch;
    if (result.length >= 8) break;
  }
  return result;
}

/**
 * Оставляет только допустимый префикс цифр даты рождения.
 * `previousDigits` помогает при посимвольном наборе; полная восьмёрка проверяется целиком
 * (чтобы можно было исправить 28.02.2000 → 29.02.2000).
 */
export function filterBirthDateDigits(attempted: string, previousDigits = ""): string {
  const raw = attempted.replace(/\D/g, "").slice(0, 8);
  if (!raw.length) return "";

  if (raw.length === 8 && birthDateDigitsToIso(raw)) {
    return raw;
  }

  const prev = previousDigits.replace(/\D/g, "");

  if (prev.length && raw.length < prev.length) {
    return filterBirthDateDigitsForward(raw);
  }

  if (prev.length && raw.startsWith(prev)) {
    let result = prev;
    for (const ch of raw.slice(prev.length)) {
      if (!isBirthDateDigitAllowed(result, ch)) break;
      result += ch;
    }
    return result;
  }

  return filterBirthDateDigitsForward(raw);
}

export function isoToBirthDateDigits(iso: string): string {
  const trimmed = iso.trim();
  const match = ISO_RE.exec(trimmed);
  if (!match) return "";
  return `${match[3]}${match[2]}${match[1]}`;
}

export function isoToBirthDateDisplay(iso: string): string {
  const digits = isoToBirthDateDigits(iso);
  return digits ? formatBirthDateDigits(digits) : "";
}

export function formatBirthDateDigits(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 8);
  if (!d.length) return "";

  let out = d.slice(0, 2);
  if (d.length > 2) out += `.${d.slice(2, 4)}`;
  if (d.length > 4) out += `.${d.slice(4, 8)}`;
  return out;
}

export function birthDateDigitsToIso(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 8) return null;

  const day = Number(d.slice(0, 2));
  const month = Number(d.slice(2, 4));
  const year = Number(d.slice(4, 8));

  const today = getTodayLocal();
  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < BIRTH_YEAR_MIN ||
    year > today.year
  ) {
    return null;
  }

  if (!isDateNotAfterToday(day, month, year)) {
    return null;
  }

  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    return null;
  }

  return iso;
}

export function isBirthDateDigitsComplete(digits: string): boolean {
  return digits.replace(/\D/g, "").length === 8;
}
