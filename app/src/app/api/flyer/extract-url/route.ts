// src/app/api/flyer/extract-url/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildFlyerExtractPrompt,
  buildFlyerIngredientExtractPrompt,
  safeParseJsonFromModel,
  normalizeFlyerItem,
  makeDedupKey,
  type FlyerItem,
} from '@/app/lib/flyer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

type StoreId = 'aoba_oshima' | 'life_kawasaki_oshima' | 'itoyokado_kawasaki';

const ALLOWLIST: Record<StoreId, string[]> = {
  aoba_oshima: ['www.bicrise.com', 'bicrise.com'],
  life_kawasaki_oshima: [
    'store.lifecorp.jp',
    'meocloud-image.s3.ap-northeast-1.amazonaws.com',
    'image.tokubai.co.jp',
  ],
  itoyokado_kawasaki: [
    'stores.itoyokado.co.jp',
    'asp.shufoo.net',
    's-cmn.shufoo.net',
    'cmn.shufoo.net',
    'www.shufoo.net',
    'ipqcache1.shufoo.net',
    'ipqcache2.shufoo.net',
  ],
};

type Tile = {
  buf: Buffer;
  pageIndex: number;
  tileIndexInPage: number;
};

function decodeHtmlEntities(input: string) {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ');
}

function toAbsUrl(raw: string, baseUrl: string) {
  const s = decodeHtmlEntities(raw.trim());
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractMetaImages(html: string, baseUrl: string) {
  const out: string[] = [];
  const re = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const abs = toAbsUrl(m[1], baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

function extractAttrUrls(html: string, baseUrl: string) {
  const out: string[] = [];
  const re = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const abs = toAbsUrl(m[1], baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

function extractRawUrls(html: string) {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"'<>]+/g;
  const m = html.match(re);
  if (m) out.push(...m.map(decodeHtmlEntities));
  return out;
}

function extractCssUrls(html: string, baseUrl: string) {
  const out: string[] = [];
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const abs = toAbsUrl(m[1], baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

function uniq(xs: string[]) {
  return Array.from(new Set(xs));
}

function assertAllowedUrl(storeId: StoreId, urlStr: string) {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid url: ${urlStr}`);
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Only http/https allowed: ${urlStr}`);
  }

  const allowedHosts = ALLOWLIST[storeId] ?? [];
  if (!allowedHosts.includes(u.hostname)) {
    throw new Error(`URL host not allowed for ${storeId}: ${u.hostname}`);
  }

  return u;
}

async function fetchBuffer(urlStr: string, maxBytes = 40 * 1024 * 1024) {
  const res = await fetch(urlStr, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (flyer-menu; +https://example.invalid)',
      Accept: '*/*',
    },
  });

  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  if (buf.length > maxBytes) {
    throw new Error(`too large: ${buf.length} bytes (max ${maxBytes})`);
  }

  return { buf, contentType };
}

function isPdfByTypeOrUrl(contentType: string, urlStr: string) {
  return contentType.includes('application/pdf') || urlStr.toLowerCase().endsWith('.pdf');
}

function isHtmlByTypeOrSniff(contentType: string, buf: Buffer) {
  if (contentType.includes('text/html')) return true;
  // 先頭が "<" ならHTMLっぽい（雑に）
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<');
}

function scoreShufooImage(u: string) {
  const s = u.toLowerCase();
  let score = 0;

  if (s.includes('s-cmn.shufoo.net') || s.includes('cmn.shufoo.net')) score += 90;
  if (s.includes('shufoo')) score += 30;

  // サムネっぽいのは強く落とす
  if (s.includes('thumb') || s.includes('thumbnail') || s.includes('btn') || s.includes('icon')) score -= 120;
  if (s.includes('thumb-size=m') || s.includes('content-width=310') || s.includes('content-height=310')) score -= 120;

  // 画像拡張子
  if (s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') || s.endsWith('.webp')) score += 20;

  // “大きいビュー”っぽいパラメータがあれば加点
  if (s.includes('imwidth=') || s.includes('width=') || s.includes('w=')) score += 10;

  return score;
}

function normalizeShufooImageUrl(u: string) {
  // 可能なら “大きめ” に寄せる（効く時だけ効く）
  try {
    const url = new URL(u);
    if (url.hostname.endsWith('shufoo.net')) {
      if (url.searchParams.has('thumb-size')) url.searchParams.set('thumb-size', 'l');
      if (url.searchParams.has('imwidth')) url.searchParams.set('imwidth', '2000');
      if (url.searchParams.has('w')) url.searchParams.set('w', '2000');
      if (url.searchParams.has('width')) url.searchParams.set('width', '2000');
      if (url.searchParams.has('content-width')) url.searchParams.set('content-width', '1200');
      if (url.searchParams.has('content-height')) url.searchParams.set('content-height', '1200');
    }
    return url.toString();
  } catch {
    return u;
  }
}

function looksLikeImageUrl(u: string) {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.png') || path.endsWith('.webp');
  } catch {
    const s = u.toLowerCase().split('?')[0] ?? '';
    return s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') || s.endsWith('.webp');
  }
}

function looksLikeThumbUrl(u: string) {
  const s = u.toLowerCase();
  return (
    s.includes('thumb') ||
    s.includes('thumbnail') ||
    s.includes('thumb-size=m') ||
    s.includes('content-width=310') ||
    s.includes('content-height=310')
  );
}

function toTokubaiHighRes(urlStr: string) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname.includes('tokubai.co.jp')) return urlStr;
    if (u.pathname.includes('/images/bargain_office_leaflets/')) {
      u.pathname = u.pathname.replace(/\/images\/bargain_office_leaflets\/[^/]+\//, '/images/bargain_office_leaflets/o=true/');
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}

function isLifeLeafletUrl(urlStr: string) {
  try {
    const u = new URL(urlStr);
    return u.hostname === 'image.tokubai.co.jp' && u.pathname.includes('/images/bargain_office_leaflets/');
  } catch {
    return false;
  }
}

type ShufooTile = {
  url: string;
  row: number;
  col: number;
  page: number | null;
};

function expandShufooTileUrls(urlStr: string) {
  try {
    const u = new URL(urlStr);
    const path = u.pathname;
    const basename = path.slice(path.lastIndexOf('/') + 1);
    const m = basename.match(/^(\d+)_(\d+)_(\d+)\.(jpg|jpeg|png|webp)$/i);
    if (!m) return null;
    const page = Number(m[1]);
    const size = Number(m[2]);
    const tileIndex = Number(m[3]);
    if (!Number.isFinite(page) || !Number.isFinite(size) || !Number.isFinite(tileIndex)) return null;
    const dir = path.slice(0, path.length - basename.length);
    const base = `${u.origin}${dir}`;
    const urls: string[] = [];
    for (const p of [page, page + 1]) {
      for (let i = 0; i < 4; i++) {
        urls.push(`${base}${p}_${size}_${i}.jpg`);
      }
    }
    return urls;
  } catch {
    return null;
  }
}

function parseShufooTileUrl(urlStr: string) {
  try {
    const u = new URL(urlStr);
    const path = u.pathname;
    const basename = path.slice(path.lastIndexOf('/') + 1);
    const m3 = basename.match(/^(\d+)_(\d+)_(\d+)\.(jpg|jpeg|png|webp)$/i);
    if (m3) {
      const page = Number(m3[1]);
      const size = Number(m3[2]);
      const tileIndex = Number(m3[3]);
      if (!Number.isFinite(page) || !Number.isFinite(size) || !Number.isFinite(tileIndex)) return null;
      if (tileIndex < 0 || tileIndex > 3) return null;
      const row = Math.floor(tileIndex / 2);
      const col = tileIndex % 2;
      const dir = path.slice(0, path.length - basename.length);
      const key = `${u.origin}${dir}${page}_${size}`;
      return { key, tile: { url: urlStr, row, col, page } as ShufooTile };
    }

    const m = basename.match(/^(.*)_([0-9])([0-9])\.(jpg|jpeg|png|webp)$/i);
    if (!m) return null;
    const baseName = m[1];
    const row = Number(m[2]);
    const col = Number(m[3]);
    const dir = path.slice(0, path.length - basename.length);
    const key = `${u.origin}${dir}${baseName}`;
    return { key, tile: { url: urlStr, row, col, page: null } as ShufooTile };
  } catch {
    return null;
  }
}

function pickShufooTileGroups(urls: string[]) {
  const groups = new Map<string, ShufooTile[]>();
  for (const u of urls) {
    const parsed = parseShufooTileUrl(u);
    if (!parsed) continue;
    const list = groups.get(parsed.key) ?? [];
    list.push(parsed.tile);
    groups.set(parsed.key, list);
  }

  const list = Array.from(groups.entries())
    .map(([key, tiles]) => ({ key, tiles }))
    .filter((x) => x.tiles.length >= 2)
    .sort((a, b) => b.tiles.length - a.tiles.length);

  if (list.length === 0) return [];

  return list.sort((a, b) => {
    const ap = a.tiles[0]?.page ?? -1;
    const bp = b.tiles[0]?.page ?? -1;
    return ap - bp;
  });
}

async function composeShufooTiles(args: { storeId: StoreId; tiles: ShufooTile[] }) {
  const { storeId, tiles } = args;
  const entries: Array<{ buf: Buffer; row: number; col: number; width: number; height: number }> = [];

  for (const tile of tiles) {
    assertAllowedUrl(storeId, tile.url);
    const { buf } = await fetchBuffer(tile.url);
    const normalized = await sharp(buf).png().toBuffer();
    const meta = await sharp(normalized).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) continue;
    entries.push({ buf: normalized, row: tile.row, col: tile.col, width, height });
  }

  if (entries.length < 2) return null;

  const tileWidth = entries[0].width;
  const tileHeight = entries[0].height;

  const rows = entries.map((e) => e.row);
  const cols = entries.map((e) => e.col);
  const minRow = Math.min(...rows);
  const minCol = Math.min(...cols);
  const maxRow = Math.max(...rows);
  const maxCol = Math.max(...cols);

  const width = (maxCol - minCol + 1) * tileWidth;
  const height = (maxRow - minRow + 1) * tileHeight;

  const composites = entries.map((e) => ({
    input: e.buf,
    left: (e.col - minCol) * tileWidth,
    top: (e.row - minRow) * tileHeight,
  }));

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function resolvePageToAssetUrls(args: { storeId: StoreId; pageUrl: string; warnings: string[] }) {
  const { storeId, pageUrl, warnings } = args;

  // ページ自体が許可ホストであること
  assertAllowedUrl(storeId, pageUrl);

  const { buf, contentType } = await fetchBuffer(pageUrl, 10 * 1024 * 1024);
  if (!isHtmlByTypeOrSniff(contentType, buf)) return [];

  const html = buf.toString('utf8');

  // 1) og:image / twitter:image を最優先
  const meta = extractMetaImages(html, pageUrl).filter(looksLikeImageUrl).map(normalizeShufooImageUrl);

  // 2) それ以外のURLも拾う
  const all = uniq([
    ...meta,
    ...extractAttrUrls(html, pageUrl),
    ...extractRawUrls(html),
    ...extractCssUrls(html, pageUrl),
  ]);

  const imgs = all
    .filter(looksLikeImageUrl)
    .map(normalizeShufooImageUrl)
    .filter((u) => {
      try {
        // 画像URLも allowlist に乗ってる必要がある
        assertAllowedUrl(storeId, u);
        return true;
      } catch {
        return false;
      }
    });

  if (storeId === 'itoyokado_kawasaki') {
    // Shufoo: “サムネ一覧”より “メイン画像” を優先
    const sorted = imgs.sort((a, b) => scoreShufooImage(b) - scoreShufooImage(a));
    const nonThumbs = sorted.filter((u) => !looksLikeThumbUrl(u));

    const picked = (nonThumbs.length > 0 ? nonThumbs : sorted).slice(0, 3);

    if (picked.length === 0) {
      warnings.push('大きい画像URLを取れませんでした（HTML内に見つからない）。必要なら Playwright方式に切り替えます。');
      return [];
    }
    if (nonThumbs.length === 0) {
      warnings.push('大きい画像URLを取れませんでした（サムネしか拾えてない可能性）。必要なら Playwright方式に切り替えます。');
    }
    return picked;
  }

  // ほかの店：とりあえず上位数枚を返す
  imgs.sort((a, b) => scoreShufooImage(b) - scoreShufooImage(a));
  return imgs.slice(0, 3);
}

async function convertPdfToPngPages(pdf: Buffer): Promise<Buffer[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-pdf-'));
  const inPath = path.join(dir, 'input.pdf');
  const outPrefix = path.join(dir, 'out');

  await fs.writeFile(inPath, pdf);

  try {
    await execFileAsync('pdftoppm', ['-png', '-r', '200', inPath, outPrefix]);

    const files = (await fs.readdir(dir))
      .filter((f) => /^out-\d+\.png$/.test(f))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] ?? 0);
        const nb = Number(b.match(/\d+/)?.[0] ?? 0);
        return na - nb;
      });

    const pages: Buffer[] = [];
    for (const f of files) pages.push(await fs.readFile(path.join(dir, f)));
    return pages;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function tileImagePng(
  png: Buffer,
  pageIndex: number,
  tileSize = 1024,
  overlap = 96,
  maxTilesTotal = 200
): Promise<Tile[]> {
  const base = sharp(png).png();
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return [];

  const step = Math.max(1, tileSize - overlap);

  const tiles: Tile[] = [];
  let tileIndexInPage = 0;

  for (let top = 0; top < h; top += step) {
    for (let left = 0; left < w; left += step) {
      const width = Math.min(tileSize, w - left);
      const height = Math.min(tileSize, h - top);

      const buf = await sharp(png)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();

      tiles.push({ buf, pageIndex, tileIndexInPage });
      tileIndexInPage++;

      if (tiles.length >= maxTilesTotal) return tiles;
    }
  }

  return tiles;
}

async function callGeminiForTile(args: {
  apiKey: string;
  modelName: string;
  maxOutputTokens: number;
  tile: Tile;
  tileIndexGlobal: number;
  tileCountGlobal: number;
  mode: 'all' | 'ingredients';
}) {
  const { apiKey, modelName, maxOutputTokens, tile, tileIndexGlobal, tileCountGlobal, mode } = args;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt =
    mode === 'ingredients'
      ? buildFlyerIngredientExtractPrompt({ tileIndex: tileIndexGlobal, tileCount: tileCountGlobal })
      : buildFlyerExtractPrompt({ tileIndex: tileIndexGlobal, tileCount: tileCountGlobal });

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              data: tile.buf.toString('base64'),
              mimeType: 'image/png',
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens,
    },
  });

  const raw = result.response.text();

  const parsed = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return safeParseJsonFromModel(raw);
    }
  })();

  const itemsRaw = Array.isArray(parsed?.items) ? parsed.items : [];
  return { itemsRaw, rawHead: raw.slice(0, 200) };
}

export async function POST(req: Request) {
  const started = Date.now();
  const warnings: string[] = [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY is missing' }, { status: 500 });
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
  const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? '8192');

  const body = await req.json().catch(() => null);
  const mode = body?.mode === 'ingredients' ? 'ingredients' : 'all';
  const maxTiles = Number(body?.maxTiles ?? process.env.FLYER_MAX_TILES ?? '200');

  const storeId = body?.storeId as StoreId | undefined;
  const urls = (body?.urls ?? (body?.url ? [body.url] : [])) as unknown;

  if (!storeId || !(storeId in ALLOWLIST)) {
    return NextResponse.json(
      { error: 'storeId is required (aoba_oshima | life_kawasaki_oshima | itoyokado_kawasaki)' },
      { status: 400 }
    );
  }
  if (!Array.isArray(urls) || urls.length === 0 || typeof urls[0] !== 'string') {
    return NextResponse.json({ error: 'urls is required (string[])' }, { status: 400 });
  }

  // 0) “ページURL” が来たら、先に “大きい画像/PDFの直URL” へ解決する
  const inputUrls: string[] = [];
  for (const u of urls as string[]) {
    try {
      // まず store allowlist チェック
      assertAllowedUrl(storeId, u);

      // 速攻で拡張子が画像/PDFならそのまま
      if (isPdfByTypeOrUrl('', u) || looksLikeImageUrl(u)) {
        inputUrls.push(u);
        continue;
      }

      // fetch して HTML なら resolve
      const { buf, contentType } = await fetchBuffer(u, 10 * 1024 * 1024);
      if (isHtmlByTypeOrSniff(contentType, buf)) {
        const resolved = await resolvePageToAssetUrls({ storeId, pageUrl: u, warnings });
        if (resolved.length > 0) inputUrls.push(...resolved);
        else warnings.push(`ページを直URLへ解決できませんでした: ${u}`);
      } else {
        // 画像でもPDFでもない → 何もしない
        warnings.push(`Unsupported URL type (not html/image/pdf): ${u} (${contentType})`);
      }
    } catch (e: any) {
      warnings.push(`resolve failed: ${u} :: ${String(e?.message ?? e)}`);
    }
  }

  if (inputUrls.length === 0) {
    return NextResponse.json(
      {
        items: [],
        count: 0,
        meta: { model: modelName, pages: 0, tiles: 0, elapsedMs: Date.now() - started, maxOutputTokens },
        warnings: [...warnings, '入力URLから処理可能な画像/PDFが見つかりませんでした。'],
      },
      { status: 200 }
    );
  }

  // 0.5) イトーヨーカドーのタイルURLなら表/裏のタイルを自動展開
  if (storeId === 'itoyokado_kawasaki') {
    const expanded = inputUrls.flatMap((u) => expandShufooTileUrls(u) ?? []);
    if (expanded.length > 0) {
      inputUrls.push(...expanded);
    }
  }

  if (storeId === 'life_kawasaki_oshima') {
    for (let i = 0; i < inputUrls.length; i++) {
      inputUrls[i] = toTokubaiHighRes(inputUrls[i]);
    }
    const filtered = inputUrls.filter(isLifeLeafletUrl);
    inputUrls.length = 0;
    inputUrls.push(...filtered);
  }

  // 1) URLからバイナリ取得 → PNG化（PDFならページ展開）
  const pagePngs: Buffer[] = [];

  const tileGroups = storeId === 'itoyokado_kawasaki' ? pickShufooTileGroups(inputUrls) : [];
  const stitchedTileUrls = new Set<string>();

  for (const group of tileGroups) {
    try {
      const stitched = await composeShufooTiles({ storeId, tiles: group.tiles });
      if (stitched) {
        pagePngs.push(stitched);
        group.tiles.forEach((t) => stitchedTileUrls.add(t.url));
      } else {
        warnings.push('タイル画像の合成に失敗しました（有効なタイルが不足）。');
      }
    } catch (e: any) {
      warnings.push(`タイル画像の合成に失敗: ${String(e?.message ?? e)}`);
    }
  }

  for (const urlStr of inputUrls) {
    try {
      if (stitchedTileUrls.has(urlStr)) continue;
      assertAllowedUrl(storeId, urlStr);

      const { buf, contentType } = await fetchBuffer(urlStr);

      if (isPdfByTypeOrUrl(contentType, urlStr)) {
        const pages = await convertPdfToPngPages(buf);
        if (pages.length === 0) warnings.push(`PDF had 0 pages after convert: ${urlStr}`);
        pagePngs.push(...pages);
      } else {
        // 画像のはず
        const normalized = await sharp(buf).png().toBuffer();
        pagePngs.push(normalized);
      }
    } catch (e: any) {
      warnings.push(`fetch/normalize failed: ${urlStr} :: ${String(e?.message ?? e)}`);
    }
  }

  if (pagePngs.length === 0) {
    return NextResponse.json(
      {
        items: [],
        count: 0,
        meta: { model: modelName, pages: 0, tiles: 0, elapsedMs: Date.now() - started, maxOutputTokens },
        warnings: [...warnings, 'ページ画像が用意できませんでした。'],
      },
      { status: 200 }
    );
  }

  // 2) タイル化
  const tiles: Tile[] = [];
  const maxTilesTotal = maxTiles;

  for (let i = 0; i < pagePngs.length; i++) {
    const pageTiles = await tileImagePng(pagePngs[i], i, 1024, 96, maxTilesTotal - tiles.length);
    tiles.push(...pageTiles);
    if (tiles.length >= maxTilesTotal) break;
  }

  if (tiles.length === 0) {
    return NextResponse.json(
      {
        items: [],
        count: 0,
        meta: { model: modelName, pages: pagePngs.length, tiles: 0, elapsedMs: Date.now() - started, maxOutputTokens },
        warnings: [...warnings, 'タイルが生成できませんでした。'],
      },
      { status: 200 }
    );
  }

  // 3) Gemini 逐次呼び出し（安定優先）
  const allItems: FlyerItem[] = [];
  for (let i = 0; i < tiles.length; i++) {
    try {
      const { itemsRaw } = await callGeminiForTile({
        apiKey,
        modelName,
        maxOutputTokens,
        tile: tiles[i],
        tileIndexGlobal: i + 1,
        tileCountGlobal: tiles.length,
        mode,
      });

      for (const r of itemsRaw) {
        const it = normalizeFlyerItem(r);
        if (it) allItems.push(it);
      }
    } catch (e: any) {
      warnings.push(
        `JSON parse failed (tile ${i + 1}/${tiles.length}). raw head: ${String(e?.message ?? e).slice(0, 200)}`
      );
    }
  }

  // 4) 重複除去
  const map = new Map<string, FlyerItem>();
  for (const it of allItems) map.set(makeDedupKey(it), it);
  const items = Array.from(map.values());
  const limitedItems = mode === 'ingredients' ? items.slice(0, 30) : items;

  return NextResponse.json({
    items: limitedItems,
    count: limitedItems.length,
    meta: {
      model: modelName,
      pages: pagePngs.length,
      tiles: tiles.length,
      elapsedMs: Date.now() - started,
      maxOutputTokens,
      storeId,
      inputUrls,
    },
    warnings,
  });
}
