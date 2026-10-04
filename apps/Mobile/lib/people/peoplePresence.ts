/** Presence on People registers only while the tab is focused. */
export function peoplePresenceShouldRegister(tabFocused: boolean): boolean {
  return tabFocused;
}
