/** Text as HTML: what would start a tag or an entity, or end an attribute, escaped. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
