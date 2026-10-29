/** A function that has `draw` run once in the next animation frame, however often it's called before then. */
export function perFrame(draw: () => void): () => void {
  let frame = 0;
  return () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };
}
