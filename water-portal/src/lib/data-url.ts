/*
 * The static data files' URLs (public/data: the lists, the dams, the rivers…), with a
 * version that changes when a file does (worked out at build time from their contents:
 * see vite.config.ts; index.html's preloads carry it too), so browsers and the site's
 * host never serve an old copy after the data are rebuilt. (Vite hashes the names of
 * imported files, not public/'s.) The model's output has its own: see basin/model.ts.
 */
const VERSION = import.meta.env.VITE_DATA_VERSION as string;

export const dataUrl = (path: string) => `${import.meta.env.BASE_URL}data/${path}?v=${VERSION}`;
