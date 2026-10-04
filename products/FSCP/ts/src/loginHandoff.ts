/**
 * Login handoff: single-use, in-memory transfer of an already-proven account password from
 * the login flow to the very first post-login restore attempt.
 *
 * ЗАЧЕМ. Пароль доступен клиенту только в момент логина (login/page.tsx). Дальше он
 * выбрасывается, дашборд резолвит FSCP-материал беспарольно, и если логин-синк не успел
 * восстановить ключи из-за транзиентного сбоя (см. `resilience.ts`
 * `FscpTransportFailureClass`, значение `"transient"`), пользователю в противном случае
 * пришлось бы вручную вводить тот же самый пароль ещё раз секунду после входа. Этот модуль
 * доигрывает restore молча, один раз, тем же паролем.
 *
 * МОДЕЛЬ УГРОЗ.
 * - Что хранится: пароль аккаунта в виде plaintext-строки, привязанный к одному нормализо-
 *   ванному владельцу (`ownerNorm`), плюс момент истечения.
 * - Сколько живёт: не дольше `ttlMs` (по умолчанию 90с от wall-clock `Date.now()`) И не
 *   более одного успешного `take` — что наступит раньше. Никакой персистентности: значение
 *   существует только как переменная в замыкании этого модуля (module-scope), не в
 *   `localStorage`/`sessionStorage`/cookie/IndexedDB и не на каком-либо глобальном объекте
 *   окна. Перезагрузка страницы (в том числе hard refresh той же вкладки) значение теряет —
 *   это осознанная часть модели угроз, а не недоработка: модуль сознательно жертвует
 *   «переживает reload» в пользу «никогда не касается персистентного/инспектируемого
 *   хранилища».
 * - Кто может достать: любой код, способный выполниться в том же origin/realm пока модуль
 *   жив — то есть ровно тот же уровень доступа, что и у XSS, которая могла бы прочитать
 *   пароль прямо из `<input>` формы логина секундой раньше. Этот модуль не создаёт новую
 *   поверхность атаки — он лишь продлевает окно, в течение которого *уже существующее*
 *   in-memory JS-состояние содержит пароль.
 * - Почему окно экспозиции минимально: `stashProvenAccountPassword` вызывается только из
 *   логин-флоу, и только после того, как синк на логине уже попытался восстановить ключи и
 *   провалился именно с `"transient"` (то есть restore был реально нужен и первая попытка
 *   его не закрыла). Успешный логин-синк ничего не сохраняет. Single-use и 90-секундный TTL
 *   дальше ограничивают, сколько это значение может значить, даже если никто явно его не
 *   очистит.
 */

/**
 * Portable surface: mirrors resilience.ts / sodium.ts — the FSCP kernel compiles against a
 * bare ES2022 lib (no DOM, no @types/node), so timers are reached through globalThis and the
 * handle type is host-specific.
 */
const hostTimers = globalThis as unknown as {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const DEFAULT_TTL_MS = 90_000;

type StashedEntry = {
  ownerNorm: string;
  password: string;
  expiresAt: number;
  /** Best-effort only — see the wall-clock check in `takeProvenAccountPassword`. */
  clearTimer: unknown;
};

let _entry: StashedEntry | null = null;

function normalizeOwner(owner: string): string {
  return owner.trim().toLowerCase();
}

function dropEntry(entry: StashedEntry | null): void {
  if (entry) hostTimers.clearTimeout(entry.clearTimer);
  _entry = null;
}

export type StashProvenAccountPasswordOptions = {
  /** Wall-clock TTL in milliseconds from the moment of stash. Defaults to 90s. */
  ttlMs?: number;
};

/**
 * Records a password just proven current by a successful `apiLogin`, for exactly one silent
 * restore attempt on this login. Call this ONLY when a restore was actually attempted and
 * failed transiently — never on success (nothing to hand off) and never on `wrong_password`
 * / `backup_not_found` (retrying the same password silently would not help and would only
 * widen the exposure window for no benefit).
 *
 * No-op for a blank/whitespace-only password or a blank owner: there is nothing useful to
 * stash, and an empty entry would just be a footgun for callers checking `take() !== null`.
 */
export function stashProvenAccountPassword(
  ownerNorm: string,
  password: string,
  opts?: StashProvenAccountPasswordOptions,
): void {
  const owner = normalizeOwner(ownerNorm);
  if (!owner || !password.trim()) return;

  // Replace, don't stack: at most one stashed password at a time, module-wide.
  dropEntry(_entry);

  const ttlMs = Math.max(0, opts?.ttlMs ?? DEFAULT_TTL_MS);
  const entry: StashedEntry = {
    ownerNorm: owner,
    password,
    expiresAt: Date.now() + ttlMs,
    // Best-effort zeroing on top of the authoritative wall-clock check below: background-tab
    // timer throttling means this may fire late (or not before the tab is torn down) — it must
    // never be the thing `take` relies on for correctness, only a courtesy early clear.
    clearTimer: hostTimers.setTimeout(() => {
      if (_entry === entry) _entry = null;
    }, ttlMs),
  };
  _entry = entry;
}

/**
 * Returns the stashed password for `ownerNorm`, or `null`. Single-use: whatever is currently
 * stashed is consumed and removed by this call, regardless of outcome.
 *
 * Deliberate behavior on an owner mismatch: the record is still dropped, not left in place for
 * a later caller. A foreign/stale entry sitting around for someone else's `take` to stumble
 * into would be worse than losing it — e.g. two logins racing in the same tab could otherwise
 * hand account A's password to a caller resolving account B. So "wrong owner" and "found
 * nothing" are observably the same to the caller (`null`), and both consume the slot.
 *
 * TTL is checked against `Date.now()` at call time (wall-clock), not via the best-effort timer
 * in `stash` — timers throttle in backgrounded tabs and must never be load-bearing for expiry.
 */
export function takeProvenAccountPassword(ownerNorm: string): string | null {
  const owner = normalizeOwner(ownerNorm);
  const entry = _entry;
  if (!entry) return null;

  dropEntry(entry);

  if (entry.ownerNorm !== owner) return null;
  if (Date.now() >= entry.expiresAt) return null;

  return entry.password;
}

/** Drops any stashed password unconditionally. Intended for session-cleared / logout hooks. */
export function clearProvenAccountPassword(): void {
  dropEntry(_entry);
}

/*
 * ОБОСНОВАНИЕ `authoritativeOverwrite: true` ДЛЯ RESTORE ЧЕРЕЗ HANDOFF.
 *
 * `ensureKeyBackupOnServer` (syncOnLogin.ts) разрешает создавать/перезаписывать backup на
 * сервере только когда `authoritativeOverwrite: true` — то есть пароль только что доказан
 * успешным `apiLogin` (см. комментарий там, строки 69-75). Молчаливый restore, запущенный из
 * значения, взятого через `takeProvenAccountPassword`, ОБЯЗАН передавать `true` в тот же
 * параметр, потому что:
 *
 * - handoff выдаётся исключительно после успешного `apiLogin` этим же паролем — это тот же
 *   «момент входа», а не отложенная во времени операция;
 *
 * - живёт не дольше 90 секунд и максимум на одно использование, так что «свежесть»
 *   доказательства пароля не размывается ожиданием — пользователь физически не мог сменить
 *   пароль в этом окне;
 *
 * - если восстановление отправить с `false` (как обычный беспарольный/inline unlock), то при
 *   сломанном (`kdf_failed`/`unreadable`) состоянии backup на сервере он останется сломанным
 *   до следующего логина — то есть handoff не выполнил бы свою единственную задачу
 *   (доиграть restore) и молча деградировал бы обратно к модалке.
 *
 * Живые сессии и inline unlock-модалка (пользователь вводит пароль вручную, не сразу после
 * входа) по-прежнему обязаны передавать `false`: там нет свежего доказательства момента
 * входа, а значит нет и права перезаписать backup, который может быть зашифрован уже под
 * новый пароль с другого устройства.
 */
