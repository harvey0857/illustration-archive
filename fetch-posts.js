#!/usr/bin/env node
/**
 * fetch-posts.js
 * 從 X API v2 增量抓取 @BirKai9453 的含圖貼文
 *
 * 功能：
 *   - 首次執行：抓取所有貼文
 *   - 之後執行：只抓取新貼文，合併到現有資料中（省 API 額度）
 *   - 加上 --full 參數可強制全量重新抓取
 *
 * 使用方式：
 *   node fetch-posts.js          ← 增量更新（只抓新的）
 *   node fetch-posts.js --full   ← 全量重新抓取
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 從 .env 讀取 token
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      const val = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const USERNAME = 'BirKai9453';
const MAX_RESULTS = 100;
const OUTPUT_FILE = path.join(__dirname, 'posts.json');
const FULL_MODE = process.argv.includes('--full');

if (!BEARER_TOKEN) {
  console.error('請設定 .env 中的 X_BEARER_TOKEN');
  process.exit(1);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Authorization': `Bearer ${BEARER_TOKEN}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
  });
}

// 讀取現有資料
function loadExisting() {
  if (FULL_MODE || !fs.existsSync(OUTPUT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function main() {
  const existing = loadExisting();
  const existingIds = new Set(existing.map(p => p.id));

  // 找出最新的 tweet ID，用於增量查詢
  let sinceId = null;
  if (existing.length > 0 && !FULL_MODE) {
    sinceId = existing.reduce((max, p) =>
      BigInt(p.id) > BigInt(max) ? p.id : max, existing[0].id
    );
  }

  console.log(FULL_MODE ? '>> 全量模式' : `>> 增量模式${sinceId ? `（since_id: ${sinceId}）` : '（首次抓取）'}`);
  console.log(`正在查詢用戶 @${USERNAME}...`);

  // 1. 取得 user ID
  const userRes = await request(
    `https://api.x.com/2/users/by/username/${USERNAME}`
  );
  const userId = userRes.data.id;

  // 2. 抓取推文
  console.log('正在抓取貼文...');
  const tweetsUrl = new URL(`https://api.x.com/2/users/${userId}/tweets`);
  tweetsUrl.searchParams.set('max_results', MAX_RESULTS);
  tweetsUrl.searchParams.set('expansions', 'attachments.media_keys');
  tweetsUrl.searchParams.set('media.fields', 'url,preview_image_url,width,height,type');
  tweetsUrl.searchParams.set('tweet.fields', 'created_at,text,public_metrics');
  tweetsUrl.searchParams.set('exclude', 'retweets,replies');

  if (sinceId) {
    tweetsUrl.searchParams.set('since_id', sinceId);
  }

  const tweetsRes = await request(tweetsUrl.toString());

  if (!tweetsRes.data || tweetsRes.data.length === 0) {
    if (sinceId) {
      console.log('沒有新貼文，資料已是最新狀態。');
    } else {
      console.log('沒有找到任何貼文。');
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    }
    return;
  }

  // 建立 media map
  const mediaMap = {};
  if (tweetsRes.includes && tweetsRes.includes.media) {
    for (const m of tweetsRes.includes.media) {
      mediaMap[m.media_key] = m;
    }
  }

  // 3. 處理新貼文
  const newPosts = [];
  for (const tweet of tweetsRes.data) {
    if (existingIds.has(tweet.id)) continue;

    const mediaKeys = tweet.attachments?.media_keys || [];
    const images = mediaKeys
      .map(key => mediaMap[key])
      .filter(m => m && m.type === 'photo')
      .map(m => ({
        url: m.url,
        width: m.width,
        height: m.height
      }));

    if (images.length === 0) continue;

    newPosts.push({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      metrics: tweet.public_metrics,
      images: images,
      tweet_url: `https://x.com/${USERNAME}/status/${tweet.id}`
    });
  }

  if (newPosts.length === 0) {
    console.log('沒有新的含圖貼文。');
    return;
  }

  // 4. 合併：新貼文放前面，按時間倒序
  const merged = FULL_MODE ? newPosts : [...newPosts, ...existing];
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2));
  console.log(`完成！新增 ${newPosts.length} 筆，總共 ${merged.length} 筆含圖貼文。`);
}

main().catch(err => {
  console.error('錯誤:', err.message);
  process.exit(1);
});
