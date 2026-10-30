/*
 * The warnings in the page's bottom-left corner, over the graph pane: about the
 * connection (slow-server.ts), servers the browser won't read from (cors-check.ts),
 * errors nothing else reports (crash-warning.ts) and the page's data not loading
 * (main.ts). Small, one above the other, with their details on hover. Each one's ⚠
 * is a button that copies a report (the message, the details, when, the page's URL
 * with its state, the browser) to the clipboard, to paste into an issue or a mail.
 */

export interface CornerWarning {
  /** Show the warning: `text` on its line, `details` on hover (both copied by the ⚠), and `after` it (a button, say). */
  show(text: string, details?: string, after?: HTMLElement): void;
  hide(): void;
  readonly hidden: boolean;
}

let box: HTMLElement | null = null;

/** A new warning in the corner, hidden until it has something to say. */
export function cornerWarning(): CornerWarning {
  if (!box) {
    box = document.createElement("div");
    box.className = "corner-warnings";
    document.body.append(box);
  }
  const warning = document.createElement("div");
  warning.className = "corner-warning";
  warning.setAttribute("role", "status");
  warning.hidden = true;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "⚠";
  copy.title = "Copy the details";
  const line = document.createElement("span");
  warning.append(copy, line);
  box.append(warning);

  let text = "";
  let details = "";
  let feedback = 0;
  copy.addEventListener("click", () => {
    void copyText(report(text, details)).then((ok) => {
      copy.textContent = ok ? "✓" : "✕";
      copy.title = ok ? "Copied" : "Couldn't copy";
      clearTimeout(feedback);
      feedback = window.setTimeout(() => {
        copy.textContent = "⚠";
        copy.title = "Copy the details";
      }, 1500);
    });
  });

  return {
    show(t, d = "", after) {
      text = t;
      details = d;
      line.textContent = t;
      line.title = d;
      for (const extra of [...warning.children].slice(2)) extra.remove();
      if (after) warning.append(" ", after);
      warning.hidden = false;
    },
    hide: () => (warning.hidden = true),
    get hidden() {
      return warning.hidden;
    },
  };
}

/** What the ⚠ copies: everything the page knows about the warning. */
function report(text: string, details: string): string {
  return [
    `Water Portal warning: ${text}`,
    details,
    "",
    `When: ${new Date().toISOString()}`,
    `Page: ${window.location.href}`,
    `Browser: ${navigator.userAgent}`,
    `Online: ${navigator.onLine}`,
    `Window: ${window.innerWidth}×${window.innerHeight} at ${window.devicePixelRatio}×`,
  ]
    .filter((row, i) => i !== 1 || row)
    .join("\n");
}

/** Puts `s` on the clipboard; true if it got there. (The clipboard API needs a secure page: else the old way.) */
async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = s;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
