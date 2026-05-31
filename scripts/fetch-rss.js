/**
 * fetch-rss.js
 * GitHub Actions から毎日 23:55 (JST) に実行される RSS 取得スクリプト。
 * 取得した記事を rss-articles.json にマージして保存する。
 * Claude Haiku API で filter-rules.txt に基づく高度なフィルタリングを実行する。
 *
 * 依存パッケージなし（Node.js 標準モジュールのみ使用）
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
const USAGE_FILE        = path.join(ROOT_DIR, "api-usage.json");
const RULES_FILE        = path.join(ROOT_DIR, "filter-rules.txt");
const KEEP_DAYS         = 30;   // 何日分の記事を保持するか
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Claude API 料金（claude-haiku-4-5）
const PRICE_INPUT_PER_MTOK  = 0.80;  // USD per 1M input tokens
const PRICE_OUTPUT_PER_MTOK = 4.00;  // USD per 1M output tokens
const JPY_PER_USD           = 155;   // 概算レート

// ===== RSS ソース一覧 =====
// NHK RSSカテゴリ対応: cat4=政治 cat5=経済 cat6=国際 cat7=スポーツ cat3=科学・医療
// ※ NHK cat8（社会）は2010年で更新停止の廃止フィードのため Yahoo 国内に差し替え
const SOURCES = [
  // NHK（カテゴリ別フィード）
  { url: "https://www3.nhk.or.jp/rss/news/cat4.xml", cat: "政治",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", cat: "経済",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat6.xml", cat: "国際",                   src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat7.xml", cat: "スポーツ",               src: "NHK" },
  { url: "https://www3.nhk.or.jp/rss/news/cat3.xml", cat: "テクノロジー",            src: "NHK科学" },
  // Yahoo ニュース（社会）※ NHK に社会専用 RSS が存在しないため
  { url: "https://news.yahoo.co.jp/rss/categories/domestic.xml", cat: "社会",       src: "Yahoo" },
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

// ===== RSS / Atom XML パーサー =====
function parseRSS(xml) {
  const items = [];

  const getText = (block, tag) => {
    let r = block.match(new RegExp(
      `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"
    ));
    if (r) return r[1].trim();
    r = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
    if (r) return r[1].trim();
    return "";
  };

  // ===== RSS: <item>...</item> =====
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

  // ===== Atom: <entry>...</entry>（RSS で0件のときのみ試みる）=====
  if (items.length === 0) {
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRe.exec(xml)) !== null) {
      const block   = m[1];
      const title   = getText(block, "title");
      // Atom のリンクは属性: <link href="https://..." rel="alternate"/>
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
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ===== pubDate を "YYYY-MM-DD"（JST）に変換 =====
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

function monthJST() {
  return todayJST().slice(0, 7); // "YYYY-MM"
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

// ===== Claude API POST =====
function claudePost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "Content-Length":    Buffer.byteLength(body),
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 60000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`Claude API HTTP ${res.statusCode}: ${text}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`Claude API JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Claude API Timeout")); });
    req.write(body);
    req.end();
  });
}

// ===== APIトークン使用量を累積保存 =====
function updateUsage(inputTokens, outputTokens) {
  let usage = {
    month: monthJST(),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.0,
    costJpy: 0,
    lastRun: "",
  };

  if (fs.existsSync(USAGE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
      // 月が変わったらリセット
      if (saved.month === monthJST()) {
        usage = saved;
      }
    } catch (_) {}
  }

  usage.inputTokens  += inputTokens;
  usage.outputTokens += outputTokens;
  usage.costUsd = (
    usage.inputTokens  / 1_000_000 * PRICE_INPUT_PER_MTOK +
    usage.outputTokens / 1_000_000 * PRICE_OUTPUT_PER_MTOK
  );
  usage.costJpy = Math.round(usage.costUsd * JPY_PER_USD);
  usage.lastRun = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), "utf8");
  return usage;
}

// ===== Claude API で記事をフィルタリング =====
async function filterWithClaude(newArticles, rules) {
  if (!ANTHROPIC_API_KEY) {
    console.log("  ⚠️ ANTHROPIC_API_KEY が未設定のため AI フィルタリングをスキップ");
    return [];
  }
  if (newArticles.length === 0) {
    console.log("  新規記事なし。AI フィルタリングをスキップ");
    return [];
  }

  // 記事リストをコンパクトな形式に（トークン節約）
  const articleList = newArticles.map(a => ({
    id:    a.id,
    cat:   a.cat,
    title: a.title,
  }));

  const userMessage = `以下のフィルタールールに従って、除外すべき記事のIDを返してください。

## フィルタールール
${rules}

## 記事リスト（JSON）
${JSON.stringify(articleList, null, 0)}

## 出力形式
除外すべき記事IDのJSON配列のみを返してください。
除外する記事がない場合は空配列 [] を返してください。
説明文・コードブロック記号・余計なテキストは一切不要です。
例: ["2026-05-31-abc12345","2026-05-31-def67890"]`;

  console.log(`  Claude API 呼び出し中（${newArticles.length}件の記事を送信）...`);

  const response = await claudePost({
    model:      "claude-haiku-4-5",
    max_tokens: 1024,
    system:     "あなたはニュース記事のフィルタリングアシスタントです。ユーザーのルールに従い、除外すべき記事IDのJSON配列のみを出力します。余計な説明は一切不要です。",
    messages: [
      { role: "user", content: userMessage }
    ],
  });

  const inputTokens  = response.usage?.input_tokens  || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const usage = updateUsage(inputTokens, outputTokens);

  console.log(`  トークン使用: 入力 ${inputTokens} / 出力 ${outputTokens}`);
  console.log(`  今月累計: ¥${usage.costJpy} ($${usage.costUsd.toFixed(4)})`);

  const rawText = (response.content?.[0]?.text || "").trim();

  // JSON配列を抽出（コードブロックや余計なテキストが混入した場合にも対応）
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log(`  ⚠️ Claude API の応答が期待形式ではありません: ${rawText.slice(0, 100)}`);
    return [];
  }

  try {
    const excluded = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(excluded)) return [];
    console.log(`  AI除外: ${excluded.length}件`);
    return excluded.filter(id => typeof id === "string");
  } catch (e) {
    console.log(`  ⚠️ Claude API 応答の JSON パースに失敗: ${e.message}`);
    return [];
  }
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

  // フィルタールール読み込み
  let filterRules = "";
  if (fs.existsSync(RULES_FILE)) {
    try {
      filterRules = fs.readFileSync(RULES_FILE, "utf8");
    } catch (e) {
      console.warn(`  ⚠️ filter-rules.txt の読み込みに失敗: ${e.message}`);
    }
  }

  // 既存の AI 除外 ID を読み込む
  let aiExcludedIds = [];
  if (fs.existsSync(EXCLUDED_FILE)) {
    try {
      aiExcludedIds = JSON.parse(fs.readFileSync(EXCLUDED_FILE, "utf8"));
    } catch (e) {
      console.warn(`  ⚠️ ai-excluded-ids.json の読み込みに失敗: ${e.message}`);
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
        if (date < cutoff) continue;
        if (existingUrls.has(item.link)) continue;

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

  // ===== Claude API フィルタリング =====
  console.log("\n🤖 AI フィルタリング");
  console.log("─".repeat(50));

  let newExcludedIds = [];
  try {
    newExcludedIds = await filterWithClaude(newArticles, filterRules);
  } catch (e) {
    console.log(`  ❌ AI フィルタリングに失敗: ${e.message}`);
  }

  // 既存の除外IDと新規除外IDをマージ（30日以内のIDのみ保持）
  const allExcluded = new Set([
    ...aiExcludedIds.filter(id => {
      const datePart = id.slice(0, 10); // "YYYY-MM-DD"
      return datePart >= cutoff;
    }),
    ...newExcludedIds,
  ]);

  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...allExcluded], null, 2), "utf8");
  console.log(`  AI除外ID 保存: ${allExcluded.size} 件（うち今回新規: ${newExcludedIds.length} 件）`);

  // 古い記事を除外してマージ（新しい記事が上に来るよう日付降順でソート）
  const survived = existing.filter(a => (a.date || "") >= cutoff);
  const merged   = [...newArticles, ...survived]
    .sort((a, b) => b.date.localeCompare(a.date));

  // ファイルに書き込む
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), "utf8");

  console.log("\n" + "─".repeat(50));
  console.log(`✅ 完了: 合計取得 ${totalFetched} 件 / 新規追加 ${totalAdded} 件 / 保存合計 ${merged.length} 件`);
  console.log(`  AI除外: ${newExcludedIds.length} 件`);
  console.log(`  （${KEEP_DAYS}日以内の記事を保持: ${cutoff} 〜 ${today}）\n`);
}

main().catch(e => {
  console.error("❌ スクリプトエラー:", e);
  process.exit(1);
});
