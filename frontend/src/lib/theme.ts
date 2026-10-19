// coss ui styles dark mode from a `.dark` class on <html>. Until the manual
// light/dark override (#13), the class follows the OS setting.
export function followSystemTheme(root: HTMLElement = document.documentElement) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => root.classList.toggle("dark", query.matches);

  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
