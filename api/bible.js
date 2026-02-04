// api/bible.js
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

// Detect NT books; everything else falls back to OT
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

// ✅ parse "16", "1-16", "1 to 16", "1-end", "1-", and strip trailing punctuation like "1-end."
function parseVerseParam(v) {
  if (v == null) return null;

  // Strip trailing punctuation from Voiceflow ("1-end." / "16," / etc.)
  const raw = String(v)
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "");

  if (!raw) return null;

  // normalize "1 to 16" -> "1-16" and remove spaces
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

function findBookNode(bibleJson, bookRaw) {
  const target = normalizeBook(bookRaw);

  const names = bibleJson?.book?.will?.name || [];
  const arr = Array.isArray(names) ? names : [names];

  for (const node of arr) {
    const id = normalizeBook(node?._attributes?.id);
    const txt = normalizeBook(node?._text);

    if (id === target || txt === target) return node;

    // forgiving match (handles slight variations)
    if (id && (id.includes(target) || target.includes(id))) return node;
    if (txt && (txt.includes(target) || target.includes(txt))) return node;
  }
  return null;
}

function findChapterNode(bookNode, chapterNum) {
  const chapters = bookNode?.chapters?.chapter || [];
  const arr = Array.isArray(chapters) ? chapters : [chapters];

  for (const c of arr) {
    const id = parseInt(String(c?._attributes?.id ?? "").trim(), 10);
    if (id === chapterNum) return c;
  }
  return arr[chapterNum - 1] || null;
}

// ✅ Fix missing verses: trim verse id before /^\d+$/
function extractVerses(chapterNode) {
  const raw = chapterNode?.verse || [];
  const arr = Array.isArray(raw) ? raw : [raw];

  const out = [];

  for (const v of arr) {
    const idRaw = String(v?._attributes?.id ?? "").trim();
    if (!idRaw || !/^\d+$/.test(idRaw)) continue;

    const verseNum = parseInt(idRaw, 10);

    // ✅ Text can be in v._text OR v.woc._text (as seen in your OT/NT structure)
    let t = v?._text;

    // If v._text is missing, check woc._text
    if (!t && v?.woc?._text) t = v.woc._text;

    // Also sometimes text appears under nested nodes like v.woc._text as array
    let text = "";

    if (Array.isArray(t)) {
      text = t.join(" ").replace(/\s+/g, " ").trim();
    } else if (typeof t === "string") {
      text = t.replace(/\s+/g, " ").trim();
    } else {
      text = "";
    }

    // ✅ Clean spacing before punctuation: "world ," -> "world,"
    if (text) {
      text = text
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (text) out.push({ verse: verseNum, text });
  }

  out.sort((a, b) => a.verse - b.verse);
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

    // cache loads
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

      if (!selected.length) {
        return res.status(404).json({ error: `Verse(s) not found: ${book} ${chapter} ${verseParam}` });
      }
    } else if (verseParam) {
      return res.status(400).json({ error: `Invalid verse format: ${verseParam}` });
    }

    // Build speech for Voiceflow
    const firstV = selected[0].verse;
    const lastV = selected[selected.length - 1].verse;

    const MAX_VERSES_SPOKEN = 25;
    const clipped = selected.slice(0, MAX_VERSES_SPOKEN);

    const versesText = clipped.map(v => v.text).join(" ");
    const rangeLabel = firstV === lastV ? `verse ${firstV}` : `verses ${firstV} to ${lastV}`;

    // Add a hint if we clipped the spoken verses
    const clippedNote =
      selected.length > MAX_VERSES_SPOKEN
        ? ` I can continue if you say, continue reading.`
        : "";

    const speech = `${book} chapter ${chapter} ${rangeLabel}. ${versesText}${clippedNote}`.trim();

    return res.json({ book, chapter, verses: selected, speech });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: String(e.message || e) });
  }
};
