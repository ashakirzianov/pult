/**
 * The header's tabs that fit in `room`, each `step` wide with its gap, in
 * their order: as many as fit, at least one, the open one always among them,
 * in the last place's stead when it would not be (`PanelTabs.tsx`).
 */
export function fitTabs<Tab extends { readonly active: boolean }>(
  tabs: readonly Tab[],
  room: number,
  step: number,
): { shown: Tab[]; hidden: Tab[] } {
  const first = tabs.slice(0, Math.max(1, Math.floor(room / step)));
  const active = tabs.find((tab) => tab.active);
  const shown =
    active === undefined || first.includes(active) ? first : [...first.slice(0, -1), active];
  return { shown, hidden: tabs.filter((tab) => !shown.includes(tab)) };
}
