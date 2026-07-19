export const SCROLL_PHASE_IDLE = 0;
export const SCROLL_PHASE_DRAG = 1;
export const SCROLL_PHASE_COAST = 2;

/** waitFor + classify задерживают activate относительно последнего coast event. */
const RESUME_MAX_EVENT_GAP_MS = 400;
const RESUME_MIN_VELOCITY = 40;

export function shouldIssueVerticalFlingResume(
  alreadyIssued: boolean,
  eligible: boolean,
): boolean {
  "worklet";
  return eligible && !alreadyIssued;
}

export function eligibleVerticalFling(
  viewTag: number,
  velocityY: number,
  lastCoastEventTs: number,
  now: number,
): boolean {
  "worklet";
  return (
    viewTag > 0 &&
    now - lastCoastEventTs >= 0 &&
    now - lastCoastEventTs <= RESUME_MAX_EVENT_GAP_MS &&
    Math.abs(velocityY) >= RESUME_MIN_VELOCITY
  );
}
