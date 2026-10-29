/*
 * Mending the dams' names (build-dams.mjs). The Water Portal's CSV went through a
 * single-byte code page on its way: each accented letter is now "?" or "\uFFFD" (and a
 * non-breaking space, as at the end of many of Uruguay's names, "\uFFFD" too):
 * "Hirfanl?" is Hirfanlı, "T\uFFFDrkiye" Türkiye, "S?o" São. Each damaged name is
 * mended, as far as it can be, from:
 *
 * 1. the same dam's name in AQUASTAT's regional Excel files (an older edition, spelled
 *    right): the one name of the dam's country that fits, a mark standing for any
 *    accented letter;
 * 2. else word by word: a word that fits, from WORDS below (the commonest of the
 *    damaged ones: Havzası, Açude, Río, …) or from all the names spelled right, in the
 *    Excel files and the CSV itself (the one that fits, or by far the commonest);
 * 3. else a word's trailing "\uFFFD" is taken for a non-breaking space and dropped: at
 *    the end of the name always (Uruguay's "Sin Nombre\uFFFD"), within it if the word
 *    without it is a word spelled right. Any mark left is shown as "?".
 */
import zlib from "node:zlib";

/** AQUASTAT's dams page, whose links are the regional Excel files. */
const DAMS_PAGE = "https://www.fao.org/aquastat/en/databases/dams";

/** Words common among the damaged names, spelled right (they win over the rest). */
const WORDS = `Türkiye Côte Havzası Batı Doğu Kapalı Büyük Küçük Kızılırmak Yeşilırmak Fırat Çoruh Meriç Akarçay
  Gölü Göl Göleti Barajı Çayı Köyü Atlântico Açude Açudes Açu Litorâneas São João José Antônio Conceição Assunção
  Paraná Paraíba Parnaíba Paranaíba Piancó Amazônica Tapajós Chuí Iguaçu Poço Ribeirão Agropecuária Hidrelétrica
  Río Ríos Cañada Sarandí María Rodríguez Martínez González Fernández Hernández Sánchez García Gómez Pérez Ramón
  Rímac Hidroeléctrica Jesús Inés Raúl Simón Tomás Nicolás Andrés Joaquín Agustín Sebastián Martín`.split(/\s+/);

const MARK = /[?\uFFFD]/;
/** A damaged word: a "\uFFFD", or a "?" next to a letter. */
const damaged = (s) => s.includes("\uFFFD") || /[\p{L}]\?|\?[\p{L}]/u.test(s);
/** A pattern for a damaged string: each mark any one letter beyond ASCII. */
const fits = (s) => new RegExp(`^${[...s].map((ch) => (MARK.test(ch) ? "[^\\x00-\\x7f]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "iu");

/**
 * The mender, from the Excel files' names (iso3 → field → names) and the words of all
 * the names spelled right (word → how often). `mend(s, iso3, field)` returns the name,
 * and whether all of it was mended.
 */
export function damNameMender(names, words) {
  for (const w of WORDS) words.set(w, (words.get(w) ?? 0) + 1e6);
  const accented = [...words.keys()].filter((w) => /[^\x00-\x7f]/.test(w));
  const byLength = new Map();
  for (const w of accented) byLength.set(w.length, [...(byLength.get(w.length) ?? []), w]);
  const known = new Set([...words.keys()].map((w) => w.toLowerCase()));

  const wordCache = new Map();
  /** A damaged word, mended (null: none fits, or none by far the commonest). */
  function mendWord(w) {
    if (wordCache.has(w)) return wordCache.get(w);
    const p = fits(w);
    const found = (byLength.get(w.length) ?? []).filter((x) => p.test(x)).sort((a, b) => words.get(b) - words.get(a));
    // (Two spellings of one word, "José" and "JOSÉ", are one.)
    const distinct = [...new Set(found.map((x) => x.toLowerCase()))];
    const best = found.length && (distinct.length === 1 || words.get(found[0]) >= 3 * words.get(found.find((x) => x.toLowerCase() !== found[0].toLowerCase())))
      ? withCase(found[0], w)
      : null;
    wordCache.set(w, best);
    return best;
  }

  return function mend(s, iso3, field) {
    if (!damaged(s)) return { name: s, mended: true };
    // 1. The dam's name in the Excel files, if one fits (with or without trailing spaces).
    const trimmed = s.replace(/\uFFFD+$/u, "");
    for (const t of [s, trimmed]) {
      const p = fits(t);
      const found = [...new Set((names.get(iso3)?.get(field) ?? []).filter((x) => p.test(x)))];
      if (found.length === 1) return { name: tidy(found[0]), mended: true };
    }
    // 2. Word by word; 3. a trailing "\uFFFD" dropped (a space), the marks left as "?".
    let mended = true;
    const out = s.replace(/[\p{L}\p{N}?\uFFFD]+/gu, (w, at) => {
      if (!damaged(w)) return w;
      if (/^\uFFFD+$/u.test(w)) return "";
      const whole = mendWord(w);
      if (whole) return whole;
      // (One trailing "\uFFFD" at a time: "Sarand\uFFFD\uFFFD" is Sarandí and a space.)
      const last = !s.slice(at + w.length).trim();
      for (let rest = w; /\uFFFD$/u.test(rest); ) {
        rest = rest.slice(0, -1);
        if (!damaged(rest)) {
          if (last || known.has(rest.toLowerCase())) return rest;
          break;
        }
        const mendedRest = mendWord(rest);
        if (mendedRest) return mendedRest;
      }
      mended = false;
      return w.replace(/\uFFFD/gu, "?");
    });
    return { name: tidy(out), mended };
  };
}

/** Spaces (non-breaking ones too, as some of the Excel files' have) as single spaces. */
const tidy = (s) => s.replace(/\s+/g, " ").trim();

/** `found` in the case of `w` where it shows: all capitals, or a capital first. */
function withCase(found, w) {
  const letters = w.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toUpperCase()) return found.toUpperCase();
  if (/^\p{Lu}/u.test(w)) return found[0].toUpperCase() + found.slice(1);
  if (/^\p{Ll}/u.test(w)) return found[0].toLowerCase() + found.slice(1);
  return found;
}

/**
 * The names in AQUASTAT's regional Excel files: iso3 → field ("name", "river",
 * "basin") → names; and every word in them, with how often. None (with a warning) if
 * they can't be read: the names are then mended from the words of the CSV only.
 */
export async function excelNames() {
  const names = new Map();
  const words = new Map();
  let urls = [];
  try {
    const page = await (await fetch(DAMS_PAGE)).text();
    urls = [...new Set([...page.matchAll(/href="(https:\/\/firebasestorage[^"]*dams_eng\.xlsx[^"]*)"/g)].map((m) => m[1].replace(/&#x26;|&amp;/g, "&")))];
  } catch (err) {
    console.warn(`AQUASTAT's dams page: ${err.message}`);
  }
  if (!urls.length) console.warn("No regional Excel files found: the names are mended from their words only.");
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`${url}: ${res.status}`);
      continue;
    }
    for (const rows of xlsxSheets(Buffer.from(await res.arrayBuffer()))) {
      const head = rows.slice(0, 6).findIndex((r) => r.some((x) => /^iso/i.test(x.trim())));
      if (head < 0) continue;
      const h = rows[head].map((x) => x.trim().toLowerCase());
      const iso = h.findIndex((x) => x.startsWith("iso"));
      const fields = { name: ["name of dam", "alternate dam name"], river: ["river"], basin: ["major basin", "sub-basin"] };
      for (const r of rows.slice(head + 1)) {
        const code = r[iso]?.trim();
        if (!code) continue;
        for (const [field, cols] of Object.entries(fields)) {
          for (const c of cols) {
            const v = r[h.indexOf(c)]?.trim();
            if (!v) continue;
            if (!names.has(code)) names.set(code, new Map());
            const list = names.get(code);
            if (!list.has(field)) list.set(field, []);
            list.get(field).push(v);
          }
        }
        for (const x of r) addWords(words, x);
      }
    }
  }
  return { names, words };
}

/** Count the words of a name spelled right. */
export function addWords(words, s) {
  if (!s || damaged(s)) return;
  for (const w of s.match(/[\p{L}]+/gu) ?? []) words.set(w, (words.get(w) ?? 0) + 1);
}

// --- Reading an .xlsx: a zip of XML, just enough of it ------------------------------

/** Each sheet's rows, as lists of cell texts. */
function xlsxSheets(zip) {
  const files = unzip(zip);
  const text = (name) => files.get(name)?.toString("utf8") ?? "";
  const unescape = (s) =>
    s.replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-f]+);/gi, (_, e) =>
      e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)),
    );
  const runs = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]));
  const sheets = [];
  for (const name of [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const rows = [];
    for (const [, row] of text(name).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const [, attrs, body] of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)[1];
        const index = [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body ?? "")?.[1];
        cells[index] = type === "s" ? shared[Number(v)] : type === "inlineStr" ? runs(body ?? "") : unescape(v ?? "");
      }
      rows.push(Array.from(cells, (c) => c ?? ""));
    }
    sheets.push(rows);
  }
  return sheets;
}

/** A zip's files (stored or deflated), by name. */
function unzip(buf) {
  const files = new Map();
  // The end of the central directory: its signature, searched for from the end.
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const skip = nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    at += 46 + skip;
  }
  return files;
}
