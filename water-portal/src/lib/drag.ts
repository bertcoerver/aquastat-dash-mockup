/*
 * A pointer drag: `move` for each move of the pointer that went down, until it's let go
 * (or the browser cancels it: a touch that turns into a scroll), then `end`. Listens on
 * `target` (an element that captured the pointer, or the window for an element that
 * moves in the page and would lose the capture), and takes its listeners off again.
 */
export function drag(target: EventTarget, down: PointerEvent, move: (e: PointerEvent) => void, end?: () => void) {
  const own = (fn: (e: PointerEvent) => void) => (e: Event) => (e as PointerEvent).pointerId === down.pointerId && fn(e as PointerEvent);
  const onMove = own(move);
  const stop = own(() => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
    end?.();
  });
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}
