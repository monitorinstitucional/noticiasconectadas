import fs from "node:fs/promises";
import crypto from "node:crypto";
import Parser from "rss-parser";

const FEEDS_FILE = "feeds.json";
const OUT_FILE = "data.json";
const KEEP_HOURS = 48;

const parser = new Parser({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; NoticiasConectadas/1.0)",
    "Accept": "application/rss+xml, application/xml;q=0.9,*/*;q=0.8"
  }
});

function normalize(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchesKeywords(text, keywords) {
  const t = normalize(text);
  return (keywords || []).some(k => t.includes(normalize(k)));
}

function pickDate(item) {
  const raw = item.isoDate || item.pubDate || item.date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function makeId(source, link, title) {
  return crypto
    .createHash("sha1")
    .update(`${source}||${link}||${title}`)
    .digest("hex")
    .slice(0, 16);
}

async function main() {
  const config = JSON.parse(await fs.readFile(FEEDS_FILE, "utf-8"));

  let failures = [];
  let rawItems = [];

  for (const topicKey of Object.keys(config)) {
    const topic = config[topicKey] || {};
    const feeds = topic.feeds || [];
    const keywords = topic.keywords || [];

    for (const feed of feeds) {
      try {
        const data = await parser.parseURL(feed.url);

        for (const item of (data.items || [])) {
          if (!item.link) continue;

          const dateISO = pickDate(item);
          if (!dateISO) continue;

          const text = `${item.title || ""} ${item.contentSnippet || ""} ${item.content || ""}`;
          if (keywords.length && !matchesKeywords(text, keywords)) continue;

          rawItems.push({
            id: makeId(feed.name, item.link, item.title),
            title: item.title || "(sem título)",
            link: item.link,
            source: feed.name,
            dateISO,
            topics: [topicKey]
          });
        }
      } catch (err) {
        failures.push({ name: feed.name, url: feed.url, error: String(err.message || err) });
      }
    }
  }

  // Dedup por LINK, mesclando topics
  const map = new Map();
  for (const it of rawItems) {
    const key = it.link;
    if (!map.has(key)) {
      map.set(key, it);
    } else {
      const prev = map.get(key);
      const merged = new Set([...(prev.topics || []), ...(it.topics || [])]);
      prev.topics = [...merged];
      // mantém o mais recente se houver diferença
      if (new Date(it.dateISO) > new Date(prev.dateISO)) {
        prev.dateISO = it.dateISO;
        prev.title = it.title || prev.title;
        prev.source = it.source || prev.source;
      }
    }
  }

  let items = [...map.values()];

  // Ordena mais novo primeiro
  items.sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));

  // Janela de tempo
  const cutoff = Date.now() - KEEP_HOURS * 60 * 60 * 1000;
  items = items.filter(i => new Date(i.dateISO).getTime() >= cutoff);

  // SEMPRE escreve data.json (mesmo vazio)
  await fs.writeFile(
    OUT_FILE,
    JSON.stringify(
      { generatedAtISO: new Date().toISOString(), failures, items },
      null,
      2
    )
  );

  console.log(`OK: ${items.length} notícias (failures: ${failures.length})`);
}

main().catch(async (err) => {
  const fallback = {
    generatedAtISO: new Date().toISOString(),
    failures: [{ name: "script", url: "", error: String(err.message || err) }],
    items: []
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(fallback, null, 2));
  console.error(err);
  process.exit(1);
});
