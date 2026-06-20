export type DashboardLeaveProceed = () => void;

export type DashboardLeaveGuard = {
  shouldBlock: () => boolean;
  onLeaveAttempt: (targetHref: string, proceed: DashboardLeaveProceed) => void;
};

let leaveGuard: DashboardLeaveGuard | null = null;
let navigationPerform: ((href: string) => void) | null = null;

export function setDashboardLeaveGuard(guard: DashboardLeaveGuard | null): void {
  leaveGuard = guard;
}

export function setDashboardNavigationPerform(handler: ((href: string) => void) | null): void {
  navigationPerform = handler;
}

export function tryDashboardNavigation(targetHref: string, proceed: DashboardLeaveProceed): boolean {
  const guard = leaveGuard;
  if (!guard?.shouldBlock()) {
    proceed();
    return true;
  }
  guard.onLeaveAttempt(targetHref, proceed);
  return false;
}

export function performDashboardNavigation(href: string): void {
  if (navigationPerform) {
    navigationPerform(href);
    return;
  }
  if (typeof window !== "undefined") {
    window.location.assign(href);
  }
}
