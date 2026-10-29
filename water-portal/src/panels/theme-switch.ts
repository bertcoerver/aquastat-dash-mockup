/*
 * Light or dark: the OS setting ("auto") unless the Layers menu picks one, remembered
 * in localStorage. The page's data-theme says which (index.html sets it before the
 * stylesheets apply; the stylesheets have one block of dark colours, for it). The map
 * and panels read their colours once, at start, so a new choice reloads the page (the
 * URL hash keeps the map where it was).
 */
type ThemeChoice = "auto" | "light" | "dark";

const STORAGE_KEY = "water-portal:theme";

/** Applies the saved choice to the page and wires up the switch; returns whether it's dark. */
export function initThemeSwitch(): boolean {
  const choice = saved();
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => (document.documentElement.dataset.theme = (choice === "auto" ? system.matches : choice === "dark") ? "dark" : "light");
  apply();
  if (choice === "auto") system.addEventListener("change", apply);

  for (const input of document.querySelectorAll<HTMLInputElement>("input[name='theme']")) {
    input.checked = input.value === choice;
    input.addEventListener("change", () => {
      try {
        localStorage.setItem(STORAGE_KEY, input.value);
      } catch {
        return; // (storage blocked: a reload would lose the choice)
      }
      location.reload();
    });
  }
  return choice === "auto" ? system.matches : choice === "dark";
}

function saved(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}
