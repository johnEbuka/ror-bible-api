const fs = require("fs");
const path = require("path");

// Load JSON once when the function is first loaded
// const biblePath = path.join(process.cwd(), "englishBiblePremium.json");
const biblePath = path.join(process.cwd(), "NewKJVPremium.json");
const bibleRaw = fs.readFileSync(biblePath, "utf8");
const bibleData = JSON.parse(bibleRaw);

// Helpers
function normalize(s) {
  if (!s) return "";
  return s.toString().toLowerCase().replace(/[^a-z0-9\s]/gi, "").trim();
}

function cleanTextFragment(fragment) {
  if (!fragment) return "";
  if (Array.isArray(fragment)) return fragment.join(" ").replace(/\s+/g, " ").trim();
  return String(fragment).replace(/\s+/g, " ").trim();
}

function extractPassage(bookName, chapterNum, verseParam) {
  const bookQuery = normalize(bookName);
  const chapterQuery = chapterNum;

  const names = ((bibleData.book && bibleData.book.will && bibleData.book.will.name) || []);
  const nameArray = Array.isArray(names) ? names : [names];

  // Find book node
  let selectedBookNode = null;
  for (const n of nameArray) {
    const id = n && n._attributes && n._attributes.id ? normalize(n._attributes.id) : "";
    const text = n && n._text ? normalize(n._text) : "";
    if ((id && id === bookQuery) || (text && text.includes(bookQuery))) {
      selectedBookNode = n;
      break;
    }
  }
  if (!selectedBookNode) {
    return { error: `Book not found: ${bookName}` };
  }

  // Find chapter
  const chaptersNode = selectedBookNode.chapters && selectedBookNode.chapters.chapter || [];
  const chaptersArray = Array.isArray(chaptersNode) ? chaptersNode : [chaptersNode];

  const selectedChapterNode = chaptersArray.find((c) => {
    const id = c && c._attributes && c._attributes.id ? Number(c._attributes.id) : NaN;
    return !isNaN(id) && id === chapterQuery;
  });

  if (!selectedChapterNode) {
    return { error: `Chapter ${chapterQuery} not found in ${bookName}` };
  }

  const versesArray = Array.isArray(selectedChapterNode.verse)
    ? selectedChapterNode.verse
    : [selectedChapterNode.verse];

  function isRealVerse(node) {
    if (!node || typeof node !== "object") return false;
    if (node._attributes && node._attributes.id) {
      const idCandidate = String(node._attributes.id);
      return /^\d+$/.test(idCandidate);
    }
    if (node.num && node.num._text) {
      return /^\d+/.test(String(node.num._text).trim());
    }
    return false;
  }

  const cleanedVerses = [];
  for (const node of versesArray) {
    if (!isRealVerse(node)) continue;

    let vNum = null;
    if (node._attributes && node._attributes.id && /^\d+$/.test(String(node._attributes.id))) {
      vNum = Number(node._attributes.id);
    } else if (node.num && node.num._text) {
      vNum = Number(String(node.num._text).trim());
    }
    if (!vNum) continue;

    let text = "";
    if (node._text) {
      text = cleanTextFragment(node._text);
    }
    if (!text && typeof node === "object") {
      for (const key of Object.keys(node)) {
        if (["_attributes", "num"].includes(key)) continue;
        const value = node[key];
        if (typeof value === "string") text += " " + cleanTextFragment(value);
        if (Array.isArray(value)) text += " " + cleanTextFragment(value);
        if (value && typeof value === "object" && value._text) {
          text += " " + cleanTextFragment(value._text);
        }
      }
      text = text.trim();
    }

    cleanedVerses.push({ verse: vNum, text });
  }

  if (!cleanedVerses.length) {
    return { error: `No verses found in ${bookName} ${chapterQuery}` };
  }

  const verseRaw = (verseParam || "").trim();

  // Whole chapter
  if (!verseRaw) {
    return {
      book: bookName,
      chapter: chapterQuery,
      verses: cleanedVerses
    };
  }

  // Range "1-5"
  if (/^\d+\s*-\s*\d+$/.test(verseRaw)) {
    const parts = verseRaw.split("-").map((s) => Number(s.trim()));
    const start = parts[0];
    const end = parts[1];
    const selected = cleanedVerses.filter(v => v.verse >= start && v.verse <= end);
    if (!selected.length) {
      return { error: `Verses ${start}-${end} not found in ${bookName} ${chapterQuery}` };
    }
    return {
      book: bookName,
      chapter: chapterQuery,
      verses: selected
    };
  }

  // Single verse
  const vNum = Number(verseRaw);
  if (!Number.isFinite(vNum)) {
    return { error: `Invalid verse: ${verseRaw}` };
  }
  const found = cleanedVerses.find(v => v.verse === vNum);
  if (!found) {
    return { error: `Verse ${vNum} not found in ${bookName} ${chapterQuery}` };
  }
  return {
    book: bookName,
    chapter: chapterQuery,
    verses: [found]
  };
}

module.exports = (req, res) => {
  const { book, chapter, verse } = req.query || {};

  if (!book || !chapter) {
    res.status(400).json({ error: "book and chapter are required, e.g. ?book=Genesis&chapter=1&verse=1" });
    return;
  }

  const chapterNum = Number(chapter);
  if (!Number.isFinite(chapterNum)) {
    res.status(400).json({ error: "chapter must be a number" });
    return;
  }

  const result = extractPassage(book, chapterNum, verse);

  res.status(result.error ? 404 : 200).json(result);
};
