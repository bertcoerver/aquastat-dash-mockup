/*
 * The warnings in the page's bottom-left corner, over the graph pane: about the
 * connection (slow-server.ts) and servers the browser won't read from (cors-check.ts).
 * Small, one above the other, with their details on hover.
 */

let box: HTMLElement | null = null;

/** A new warning in the corner, hidden until it has something to say. */
export function cornerWarning(): HTMLElement {
  if (!box) {
    box = document.createElement("div");
    box.className = "corner-warnings";
    document.body.append(box);
  }
  const warning = document.createElement("div");
  warning.className = "corner-warning";
  warning.setAttribute("role", "status");
  warning.hidden = true;
  box.append(warning);
  return warning;
}
