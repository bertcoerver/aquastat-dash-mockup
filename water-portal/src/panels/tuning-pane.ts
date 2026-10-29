/*
 * The tuning pane: sliders for the look of the Basin view's particles, rain and vapour,
 * kept out of sight. A triple click on a legend opens it (and closes it again); it can
 * be dragged by its heading. Each of them adds a section (tuningSection), whose body it
 * hides while its map isn't drawn that way: the section then says how to show it.
 */

import { drag } from "../lib/drag";

let pane: HTMLElement | null = null;

function thePane(): HTMLElement {
  if (pane) return pane;
  pane = document.createElement("aside");
  pane.className = "tuning-pane";
  pane.setAttribute("aria-label", "Tuning");
  pane.hidden = true;
  pane.innerHTML =
    '<div class="tuning-pane-head"><span>Tuning</span><button type="button" class="tuning-pane-close" aria-label="Close" title="Close">×</button></div>';
  document.body.append(pane);
  const p = pane;
  p.querySelector("button")!.addEventListener("click", () => (p.hidden = true));
  dragBy(p.querySelector<HTMLElement>(".tuning-pane-head")!, p);
  document.addEventListener("click", (e) => {
    if (e.detail === 3 && (e.target as Element).closest?.(".legend")) {
      p.hidden = !p.hidden;
      getSelection()?.removeAllRanges();
    }
  });
  return pane;
}

/** A section of the tuning pane: put the controls in `body`, hide it while they don't apply. */
export function tuningSection(title: string, hint: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "tuning-section";
  section.innerHTML = `<h3></h3><div class="tuning-body"></div><p class="tuning-hint"></p>`;
  section.querySelector("h3")!.textContent = title;
  section.querySelector(".tuning-hint")!.textContent = hint;
  const body = section.querySelector<HTMLElement>(".tuning-body")!;
  body.hidden = true;
  thePane().append(section);
  return body;
}

function dragBy(handle: HTMLElement, el: HTMLElement) {
  handle.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || (down.target as Element).closest("button")) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    const { left, top } = el.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      // (Kept on screen, by its heading at least.)
      el.style.left = `${Math.min(innerWidth - 60, Math.max(0, left + e.clientX - down.clientX))}px`;
      el.style.top = `${Math.min(innerHeight - 30, Math.max(0, top + e.clientY - down.clientY))}px`;
      el.style.right = "auto";
    };
    drag(handle, down, move);
  });
}
