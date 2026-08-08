/**
 * fetch-rss-gemini.js
 * Gemini API (gemini-2.5-flash) を使用した RSS 取得およびフィルタリングテスト用スクリプト
 */

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ===== 設定 =====
const ROOT_DIR          = path.join(__dirname, "..");
const DATA_FILE         = path.join(ROOT_DIR, "rss-articles.json");
const EXCLUDED_FILE     = path.join(ROOT_DIR, "ai-excluded-ids.json");
const RULES_FILE        = path.join(ROOT_DIR, "filter-rules.txt");
const KEEP_DAYS         = 30;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY || "";

const SOURCES = [
  { url: "https://www3.nhk.or.jp/rss/news/cat4.xml", cat: "政治",               src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", cat: "経済",               src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat6.xml", cat: "国際",               src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat7.xml", cat: "スポーツ",           src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat3.xml", cat: "テクノロジー",       src: "NHK科学" },
  { url: "https://news.yahoo.co.jp/rss/categories/domestic.xml", cat: "社会",   src: "Yahoo" },
  { url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml", cat: "テクノロジー", src: "ITmedia" },
  { url: "https://natalie.mu/music/feed/news",  cat: "芸能・エンタメ・ゴシップ",    src: "natalie音楽" },
  { url: "https://natalie.mu/comic/feed/news",  cat: "芸能・エンタメ・ゴシップ",    src: "natalie漫画" },
  { url: "https://natalie.mu/eiga/feed/news",   cat: "芸能・エンタメ・ゴシップ",    src: "natalie映画" },
];

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error("Too many redirects")); return; }
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; news-daily-bot/1.0)",
        "Accept":     "application/rss+xml, application/xml, text/xml, */*",
      },
      timeout: 15000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        resolve(fetchUrl(res.headers.location, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function parseRSS(xml) {
  const items = [];
  const getText = (block, tag) => {
    let r = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"));
    if (r) return r[1].trim();
    r = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
    if (r) return r[1].trim();
    return "";
  };

  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block   = m[1];
    const title   = getText(block, "title");
    const link    = getText(block, "link") || getText(block, "guid");
    const desc    = getText(block, "description");
    const pubDate = getText(block, "pubDate") || getText(block, "dc:date") || getText(block, "published");
    if (!title || !link) continue;
    items.push({ title, link, desc, pubDate });
  }

  if (items.length === 0) {
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRe.exec(xml)) !== null) {
      const block   = m[1];
      const title   = getText(block, "title");
      const linkAttr = block.match(/<link[^>]+href="([^"]+)"/i);
      const link    = (linkAttr ? linkAttr[1] : "") || getText(block, "id");
      const desc    = getText(block, "summary") || getText(block, "content");
      const pubDate = getText(block, "published") || getText(block, "updated");
      if (!title || !link) continue;
      items.push({ title, link, desc, pubDate });
    }
  }
  return items;
}

function decodeHtml(s) {
  return (s || "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([\da-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanDesc(raw, maxLen = 200) {
  return decodeHtml(raw || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function toDateStr(pubDate) {
  if (!pubDate) return todayJST();
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return todayJST();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function todayJST() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function makeId(url, date) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${date}-${hash}`;
}

function getCutoffDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - KEEP_DAYS * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// ===== Gemini API POST =====
function geminiPost(prompt) {
  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    };
    const body = JSON.stringify(payload);

    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 60000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`Gemini API HTTP ${res.statusCode}: ${text}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`Gemini API JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gemini API Timeout")); });
    req.write(body);
    req.end();
  });
}

async function filterWithGemini(newArticles, rules) {
  if (!GEMINI_API_KEY) {
    console.log("  ⚠️ GEMINI_API_KEY 未設定のため AI フィルタリングをスキップ");
    return [];
  }
  if (newArticles.length === 0) {
    console.log("  新規記事なし。AI フィルタリングをスキップ");
    return [];
  }

  const articleList = newArticles.map(a => ({ id: a.id, cat: a.cat, title: a.title }));
  const prompt = `あなたはニュース記事のフィルタリングアシスタントです。
以下のフィルタールールに従い、除外すべき記事のIDのJSON配列のみを返してください。

## フィルタールール
${rules}

## 記事リスト
${JSON.stringify(articleList)}

## 出力形式
["id1", "id2"] の形式でJSON配列のみを出力してください。該当がない場合は [] を返してください。`;

  console.log(`  Gemini API 呼び出し中（${newArticles.length}件送信）...`);
  const response = await geminiPost(prompt);
  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  
  try {
    const excluded = JSON.parse(rawText);
    return Array.isArray(excluded) ? excluded : [];
  } catch (e) {
    console.log(`  ⚠️ Gemini API パース失敗: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log("\n📰 Gemini RSS 取得開始");
  console.log(`  実行時刻 (JST): ${new Date(Date.now() + 9*3600*1000).toISOString().replace("T"," ").slice(0,19)}`);

  let existing = [];
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) {}
  }

  let filterRules = "";
  if (fs.existsSync(RULES_FILE)) {
    try { filterRules = fs.readFileSync(RULES_FILE, "utf8"); } catch (_) {}
  }

  let aiExcludedIds = [];
  if (fs.existsSync(EXCLUDED_FILE)) {
    try { aiExcludedIds = JSON.parse(fs.readFileSync(EXCLUDED_FILE, "utf8")); } catch (_) {}
  }

  const existingUrls = new Set(existing.map(a => a.url));
  const cutoff       = getCutoffDate();
  const newArticles  = [];

  for (const source of SOURCES) {
    try {
      const xml   = await fetchUrl(source.url);
      const items = parseRSS(xml);
      for (const item of items) {
        const date = toDateStr(item.pubDate);
        if (date < cutoff || existingUrls.has(item.link)) continue;

        newArticles.push({
          id:    makeId(item.link, date),
          cat:   source.cat,
          date:  date,
          src:   source.src,
          title: decodeHtml(item.title),
          desc:  cleanDesc(item.desc),
          url:   item.link,
        });
        existingUrls.add(item.link);
      }
    } catch (e) {
      console.log(`❌ RSS取得失敗 (${source.src}): ${e.message}`);
    }
  }

  const newExcludedIds = await filterWithGemini(newArticles, filterRules);
  const allExcluded = new Set([...aiExcludedIds, ...newExcludedIds]);

  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...allExcluded], null, 2), "utf8");

  const survived = existing.filter(a => (a.date || "") >= cutoff);
  const merged   = [...newArticles, ...survived].sort((a, b) => b.date.localeCompare(a.date));

  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), "utf8");
  console.log(`✅ Gemini テスト処理完了: 新規 ${newArticles.length} 件 / AI除外 ${newExcludedIds.length} 件`);
}

main().catch(console.error);
