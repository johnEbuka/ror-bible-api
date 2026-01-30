const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const NT_URL = process.env.NT_URL;
const OT_URL = process.env.OT_URL;

let NT_CACHE = null;
let OT_CACHE = null;

const NT_BOOKS = new Set([
  "matthew","mark","luke","john","acts","romans",
  "1 corinthians","2 corinthians","galatians","ephesians","philippians","colossians",
  "1 thessalonians","2 thessalonians","1 timothy","2 timothy","titus","philemon",
  "hebrews","james","1 peter","2 peter","1 john","2 john","3 john","jude","revelation"
]);

function normalizeBook(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^first /, "1 ")
    .replace(/^second /, "2 ")
    .replace(/^third /, "3 ");
}

function isNT(bookRaw) {
  return NT_BOOKS.has(normalizeBook(bookRaw));
}

function parseVerseParam(v) {
  if (v == null) return null;
  const raw = String(v).trim().toLowerCase();
  if (!raw) return null;

  const s = raw.replace(/\s+to\s+/g, "-").replace(/\s+/g, "");

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return { start: n, end: n };
  }
  if (/^\d+\-$/.test(s)) {
    return { start: parseInt(s.slice(0, -1), 10), end: "end" };
  }
  if (/^\d+\-end$/.test(s)) {
    const start = parseInt(s.split("-")[0], 10);
    return { start, end: "end" };
  }
  if (/^\d+\-\d+$/.test(s)) {
    const [a, b] = s.split("-").map((x) => parseInt(x, 10));
    return { start: a, end: b };
  }
  return null;
}

function collectNameArrays(obj) {
  const found = [];
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

    // If this object has a `name` key that is array-like, collect it
    if (cur.name) {
      if (Array.isArray(cur.name)) found.push(cur.name);
      else if (typeof cur.name === "object") found.push([cur.name]);
    }

    // Walk children
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }

  return found;
}

function findBookNode(bibleJson, bookRaw) {
  const target = normalizeBook(bookRaw);

  // collect all candidate name arrays anywhere in the json
  const candidates = collectNameArrays(bibleJson);

  for (const arr of candidates) {
    for (const node of arr) {
      const id = normalizeBook(node?._attributes?.id);
      const txt = normalizeBook(node?._text);

      if (
        id === target ||
        txt === target ||
        id.includes(target) ||
        txt.includes(target) ||
        target.includes(id) ||
        target.includes(txt)
      ) {
        return node;
      }
    }
  }

  return null;
}

}

function findChapterNode(bookNode, chapterNum) {
  const chapters = bookNode?.chapters?.chapter || [];
  const arr = Array.isArray(chapters) ? chapters : [chapters];

  for (const c of arr) {
    const id = parseInt(c?._attributes?.id, 10);
    if (id === chapterNum) return c;
  }
  return arr[chapterNum - 1] || null;
}

function extractVerses(chapterNode) {
  const raw = chapterNode?.verse || [];
  const arr = Array.isArray(raw) ? raw : [raw];

  const out = [];
  for (const v of arr) {
    const id = v?._attributes?.id;
    if (!id || !/^\d+$/.test(String(id))) continue;

    const verseNum = parseInt(id, 10);
    const t = v?._text;

    const text = Array.isArray(t)
      ? t.join(" ").replace(/\s+/g, " ").trim()
      : (typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "");

    if (text) out.push({ verse: verseNum, text });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const book = req.query.book;
    const chapter = parseInt(req.query.chapter, 10);
    const verseParam = req.query.verse;

    if (!book || !chapter) {
      return res.status(400).json({ error: "book and chapter are required" });
    }
    if (!NT_URL || !OT_URL) {
      return res.status(500).json({ error: "Missing NT_URL or OT_URL in env vars" });
    }

    if (!NT_CACHE) NT_CACHE = await fetchJson(NT_URL);
    if (!OT_CACHE) OT_CACHE = await fetchJson(OT_URL);

    const bibleJson = isNT(book) ? NT_CACHE : OT_CACHE;

    const bookNode = findBookNode(bibleJson, book);
    if (!bookNode) return res.status(404).json({ error: `Book not found: ${book}` });

    const chapterNode = findChapterNode(bookNode, chapter);
    if (!chapterNode) return res.status(404).json({ error: `Chapter not found: ${book} ${chapter}` });

    const all = extractVerses(chapterNode);
    if (!all.length) return res.status(404).json({ error: `No verses found: ${book} ${chapter}` });

    const range = parseVerseParam(verseParam);
    let selected = all;

    if (range) {
      const start = Math.max(1, range.start);
      const end = range.end === "end" ? all[all.length - 1].verse : range.end;
      selected = all.filter(v => v.verse >= start && v.verse <= end);
      if (!selected.length) return res.status(404).json({ error: `Verse(s) not found: ${book} ${chapter} ${verseParam}` });
    } else if (verseParam) {
      return res.status(400).json({ error: `Invalid verse format: ${verseParam}` });
    }

    // speech string for Voiceflow
    const firstV = selected[0].verse;
    const lastV = selected[selected.length - 1].verse;

    const MAX_VERSES_SPOKEN = 25;
    const clipped = selected.slice(0, MAX_VERSES_SPOKEN);

    const versesText = clipped.map(v => v.text).join(" ");
    const rangeLabel = firstV === lastV ? `verse ${firstV}` : `verses ${firstV} to ${lastV}`;

    const speech = `${book} chapter ${chapter} ${rangeLabel}. ${versesText}`;

    return res.json({ book, chapter, verses: selected, speech });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: String(e.message || e) });
  }
};
