/*
 * Numbers in the page's text are formatted as en-US everywhere (1,234.5), whatever the
 * browser's locale: the text is English, so its numbers are too.
 */
export const LOCALE = "en-US";

/** With thousands separators: as many decimals as the number has, or exactly `decimals`. */
export const fmtNumber = (v: number, decimals?: number) =>
  v.toLocaleString(LOCALE, decimals === undefined ? undefined : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Large numbers short: 1.2M, 35K. */
export const compactNumber = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumSignificantDigits: 3 });
