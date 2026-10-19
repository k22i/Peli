// Everything a keyboard user can land on: Tab stops, plus the cards a row's
// arrow keys reach.
export function keyboardReachable(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex], [data-row-item]",
    ),
  ].filter((element) => element.tabIndex >= 0 || element.hasAttribute("data-row-item"));
}

// Tailwind classes can't be computed in jsdom, so check each element's own
// recipe: a focus-visible style of its own, one drawn by a child for it
// (cards ring their artwork), or no outline-none, so index.css's global
// :focus-visible ring applies.
export function hasFocusRing(element: HTMLElement): boolean {
  const own = element.getAttribute("class") ?? "";
  if (/(^|\s)focus-visible:/.test(own) || /(^|:)focus:/.test(own)) return true;
  if (element.querySelector("[class*='group-focus-visible']")) return true;
  return !/(^|\s)outline-none(\s|$)/.test(own);
}
