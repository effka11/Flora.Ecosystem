import { AsYouType, type CountryCode, parsePhoneNumberFromString } from "libphonenumber-js";

/** Дефолт при разборе сохранённых национальных строк без `+`. */
export const DEFAULT_PHONE_COUNTRY: CountryCode = "RU";

export function countryFlagEmoji(countryCode: string | undefined | null): string | null {
  if (!countryCode || countryCode.length !== 2) return null;
  const upper = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return String.fromCodePoint(...[...upper].map((ch) => 127397 + ch.charCodeAt(0)));
}

export type PhoneDraft = {
  /** Отображаемое значение: `+`, цифры и пробелы. */
  display: string;
  /** ISO 3166-1 alpha-2, если определена. */
  country: CountryCode | undefined;
  /** E.164 для API, если номер достаточно полный; иначе digits/`+`. */
  e164: string | null;
  /** Нормализованные символы (`+` и цифры) для сравнения dirty. */
  digits: string;
};

const EMPTY_DRAFT: PhoneDraft = {
  display: "",
  country: undefined,
  e164: null,
  digits: "",
};

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

function ensureLeadingPlus(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "+";
  return trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/^\+*/, "")}`;
}

/** Только пробелы как разделители — без скобок, тире и точек. */
function toSpacesOnlyDisplay(formatted: string): string {
  const trimmed = formatted.trim();
  if (!trimmed) return "";
  const hadPlus = trimmed.startsWith("+");
  const body = (hadPlus ? trimmed.slice(1) : trimmed)
    .replace(/[()\-.\u00A0]/g, " ")
    .replace(/[^\d\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return "";
  return hadPlus ? `+${body}` : body;
}

/**
 * Набор длиннее допустимого для региона: текущий не possible/valid,
 * но есть более короткий префикс, который уже possible/valid.
 */
function isPhoneDigitsTooLong(digits: string): boolean {
  if (digits.length < 2) return false;

  const current = new AsYouType();
  current.input(`+${digits}`);
  if (current.isPossible() || current.isValid()) return false;
  if (!current.getNumber()) return false;

  for (let len = digits.length - 1; len >= 1; len -= 1) {
    const shorter = new AsYouType();
    shorter.input(`+${digits.slice(0, len)}`);
    if (shorter.isPossible() || shorter.isValid()) return true;
  }
  return false;
}

function capDigitsToRegion(digits: string): string {
  let next = digits;
  while (next.length > 0 && isPhoneDigitsTooLong(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

/**
 * Флаг для UI: AsYouType часто не знает страну при общем коде (NANP +1).
 * Пока регион не уточнён — для `1` показываем US сразу.
 */
function resolveDisplayCountry(formatter: AsYouType): CountryCode | undefined {
  const country = formatter.getCountry();
  if (country) return country;
  if (formatter.getCallingCode() === "1") return "US";
  return undefined;
}

function buildDraft(digits: string): PhoneDraft {
  const formatter = new AsYouType();
  const rawInput = `+${digits}`;
  const formatted = formatter.input(rawInput);
  const display = toSpacesOnlyDisplay(ensureLeadingPlus(formatted || rawInput));
  const chars = formatter.getChars() || rawInput;
  return {
    display,
    country: resolveDisplayCountry(formatter),
    e164: formatter.getNumberValue() ?? null,
    digits: chars.startsWith("+") ? chars : `+${chars}`,
  };
}

/** Форматирует ввод as-you-type и определяет страну; лишние цифры региона отбрасывает. */
export function formatPhoneDraft(
  raw: string,
  _defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): PhoneDraft {
  let digits = digitsOnly(raw);

  // Пусто или только `+` без цифр справа — поле пустое.
  if (!digits) {
    return EMPTY_DRAFT;
  }

  digits = capDigitsToRegion(digits);
  if (!digits) return EMPTY_DRAFT;

  return buildDraft(digits);
}

/**
 * Форматирование с учётом предыдущего значения.
 * Backspace по пробелу с конца не меняет набор цифр —
 * тогда удаляем последнюю цифру.
 * Важно: не путать с onChange после форматирования (`8900` при value `+8 900`).
 */
export function formatPhoneDraftFromInput(
  raw: string,
  previousDisplay: string,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): PhoneDraft {
  const prevDigits = digitsOnly(previousDisplay);
  const nextDigits = digitsOnly(raw);

  const deletedFormattingFromEnd =
    prevDigits.length > 0 &&
    nextDigits.length === prevDigits.length &&
    raw.length < previousDisplay.length &&
    previousDisplay.startsWith(raw);

  if (deletedFormattingFromEnd) {
    const trimmed = prevDigits.slice(0, -1);
    if (!trimmed) return EMPTY_DRAFT;
    return formatPhoneDraft(`+${trimmed}`, defaultCountry);
  }

  return formatPhoneDraft(raw, defaultCountry);
}

/**
 * Номер уже на максимуме длины региона — нельзя ввести ещё одну цифру.
 * Для TextInput.maxLength (блокировка до появления символа).
 */
export function isPhoneInputAtRegionLimit(
  display: string,
  _defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  const digits = digitsOnly(display);
  if (!digits) return false;
  return isPhoneDigitsTooLong(`${digits}0`);
}

/** Начальное отображение сохранённого номера. */
export function phoneDisplayFromStored(
  stored: string,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): PhoneDraft {
  const trimmed = stored.trim();
  if (!trimmed) return EMPTY_DRAFT;

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (parsed) {
    return {
      display: toSpacesOnlyDisplay(parsed.formatInternational()),
      country: parsed.country,
      e164: parsed.number,
      digits: parsed.number,
    };
  }
  return formatPhoneDraft(trimmed.startsWith("+") ? trimmed : `+${digitsOnly(trimmed)}`);
}

/** Значение для API: E.164 если возможно, иначе нормализованные digits. */
export function phoneValueForApi(draft: PhoneDraft): string {
  if (draft.e164) return draft.e164;
  const digits = draft.digits.replace(/^\+/, "");
  if (!digits) return "";
  return draft.digits.startsWith("+") ? draft.digits : draft.digits;
}

function isBlankPhoneDigits(digits: string): boolean {
  return !digits || digits === "+";
}

/** Сравнение с сохранённым значением (без учёта пробелов форматирования). */
export function phoneDraftEqualsStored(
  draft: PhoneDraft,
  stored: string,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  const storedNorm = phoneDisplayFromStored(stored, defaultCountry);
  if (isBlankPhoneDigits(draft.digits) && isBlankPhoneDigits(storedNorm.digits)) return true;
  if (draft.e164 && storedNorm.e164) return draft.e164 === storedNorm.e164;
  return draft.digits === storedNorm.digits;
}
