/**
 * fetch-rss.js
 * GitHub Actions から毎日 23:55 (JST) に実行される RSS 取得スクリプト。
 * 取得した記事を rss-articles.json にマージして保存する。
 *
 * 依存パッケージなし（Node.js 標準モジュールのみ使用）
 */

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ===== 設定 =====
const ROOT_DIR  = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT_DIR, "rss-articles.json");
const KEEP_DAYS = 30;   // 何日分の記事を保持するか

// ===== RSS ソース一覧 =====
const SOURCES = [
  // NHK（カテゴリ別フィード）
  { url: "https://www3.nhk.or.jp/rss/news/cat4.xml", cat: "政治",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", cat: "経済",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat6.xml", cat: "社会",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat7.xml", cat: "国際",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat8.xml", cat: "スポーツ",               src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat3.xml", cat: "テクノロジー",            src: "NHK科学" },
  // ITmedia（テクノロジー）
  { url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml", cat: "テクノロジー",  src: "ITmedia" },
  // natalie（芸能・エンタメ）
  { url: "https://natalie.mu/music/feed/news",  cat: "芸能・エンタメ・ゴシップ",    src: "natalie音楽" },
  { url: "https://natalie.mu/comic/feed/news",  cat: "芸能・エンタメ・ゴシップ",    src: "natalie漫画" },
  { url: "https://natalie.mu/eiga/feed/news",   cat: "芸能・エンタメ・ゴシップ",    src: "natalie映画" },
];

// ===== HTTP GET（リダイレクト追跡、最大5回） =====
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

// ===== RSS XML パーサー =====
function parseRSS(xml) {
  const items = [];
  // <item>...</item> ブロックを抽出
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      // CDATA
      let r = block.match(new RegExp(
        `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"
      ));
      if (r) return r[1].trim();
      // 通常テキスト
      r = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
      if (r) return r[1].trim();
      return "";
    };

    const title   = get("title");
    const link    = get("link") || get("guid");
    const desc    = get("description");
    const pubDate = get("pubDate") || get("dc:date") || get("published");

    if (!title || !link) continue;
    items.push({ title, link, desc, pubDate });
  }
  return items;
}

// ===== HTML エンティティのデコード =====
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

// ===== HTML タグを除去して最大 N 文字に切り詰め =====
function cleanDesc(raw, maxLen = 200) {
  return decodeHtml(raw || "")
    .replace(/<[^>]*>/g, "")   // タグ除去
    .replace(/\s+/g, " ")      // 連続空白を1つに
    .trim()
    .slice(0, maxLen);
}

// ===== pubDate を "YYYY-MM-DD"（JST）に変換 =====
function toDateStr(pubDate) {
  if (!pubDate) return todayJST();
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return todayJST();
  // UTC → JST (+09:00)
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function todayJST() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ===== URL から短いハッシュ ID を生成 =====
function makeId(url, date) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${date}-${hash}`;
}

// ===== カットオフ日付（30日前）を計算 =====
function getCutoffDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - KEEP_DAYS * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// ===== メイン処理 =====
async function main() {
  console.log("\n📰 RSS 取得開始");
  console.log(`  実行時刻 (JST): ${new Date(Date.now() + 9*3600*1000).toISOString().replace("T"," ").slice(0,19)}`);
  console.log("─".repeat(50));

  // 既存データを読み込む
  let existing = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      console.log(`  既存記事数: ${existing.length} 件`);
    } catch (e) {
      console.warn(`  ⚠️ 既存データの読み込みに失敗: ${e.message}`);
    }
  }

  const existingUrls = new Set(existing.map(a => a.url));
  const cutoff       = getCutoffDate();
  const today        = todayJST();

  let totalFetched = 0;
  let totalAdded   = 0;
  const newArticles = [];

  // 各ソースからRSSを取得
  for (const source of SOURCES) {
    process.stdout.write(`  [${source.src}] ${source.cat} ... `);
    try {
      const xml   = await fetchUrl(source.url);
      const items = parseRSS(xml);
      let added   = 0;

      for (const item of items) {
        const date = toDateStr(item.pubDate);
        if (date < cutoff) continue;          // 古すぎる記事はスキップ
        if (existingUrls.has(item.link)) continue; // 重複スキップ

        const article = {
          id:    makeId(item.link, date),
          cat:   source.cat,
          date:  date,
          src:   source.src,
          title: decodeHtml(item.title),
          desc:  cleanDesc(item.desc),
          url:   item.link,
        };
        newArticles.push(article);
        existingUrls.add(item.link);
        added++;
        totalAdded++;
      }

      totalFetched += items.length;
      console.log(`取得 ${items.length} 件 / 新規追加 ${added} 件`);
    } catch (e) {
      console.log(`❌ 失敗 — ${e.message}`);
    }
  }

  // 古い記事を除外してマージ（新しい記事が上に来るよう日付降順でソート）
  const survived = existing.filter(a => (a.date || "") >= cutoff);
  const merged   = [...newArticles, ...survived]
    .sort((a, b) => b.date.localeCompare(a.date));

  // ファイルに書き込む
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), "utf8");

  console.log("─".repeat(50));
  console.log(`✅ 完了: 合計取得 ${totalFetched} 件 / 新規追加 ${totalAdded} 件 / 保存合計 ${merged.length} 件`);
  console.log(`  （${KEEP_DAYS}日以内の記事を保持: ${cutoff} 〜 ${today}）\n`);
}

main().catch(e => {
  console.error("❌ スクリプトエラー:", e);
  process.exit(1);
});
