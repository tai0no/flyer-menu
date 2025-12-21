// src/app/api/flyer/extract/route.ts
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
  safeParseJsonFromModel,
  normalizeFlyerItem,
  makeDedupKey,
  type FlyerItem,
} from '@/app/lib/flyer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

type Tile = {
  buf: Buffer;
  pageIndex: number;
  tileIndexInPage: number;
};

function isPdf(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function convertPdfToPngPages(pdf: Buffer): Promise<Buffer[]> {
  // pdftoppm を使って PDF -> PNG(各ページ) にする
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-pdf-'));
  const inPath = path.join(dir, 'input.pdf');
  const outPrefix = path.join(dir, 'out');

  await fs.writeFile(inPath, pdf);

  try {
    // 解像度はまず 200dpi（重いなら150、細かいなら250）
    await execFileAsync('pdftoppm', ['-png', '-r', '200', inPath, outPrefix]);

    const files = (await fs.readdir(dir))
      .filter((f) => /^out-\d+\.png$/.test(f))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] ?? 0);
        const nb = Number(b.match(/\d+/)?.[0] ?? 0);
        return na - nb;
      });

    const pages: Buffer[] = [];
    for (const f of files) {
      pages.push(await fs.readFile(path.join(dir, f)));
    }
    return pages;
  } finally {
    // 掃除
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
}) {
  const { apiKey, modelName, maxOutputTokens, tile, tileIndexGlobal, tileCountGlobal } = args;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = buildFlyerExtractPrompt({ tileIndex: tileIndexGlobal, tileCount: tileCountGlobal });

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
      // ★ ここがJSONパース失敗の最大対策：JSONだけ返させる
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens,
    },
  });

  const raw = result.response.text();

  // JSONだけのはずだが、保険で safeParse
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

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required (multipart/form-data)' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // 1) PDFなら「必ず画像化してから」Geminiへ送る（取りこぼし激減）
  let pagePngs: Buffer[] = [];
  try {
    if (isPdf(file)) {
      pagePngs = await convertPdfToPngPages(buf);
      if (pagePngs.length === 0) {
        warnings.push('PDF->PNG 変換後のページ画像が0でした。');
      }
    } else {
      // 画像の場合はそのままPNGへ
      const normalized = await sharp(buf).png().toBuffer();
      pagePngs = [normalized];
    }
  } catch (e: any) {
    warnings.push(`PDF/IMG normalize failed: ${String(e?.message ?? e)}`);
    return NextResponse.json({ error: 'PDF/IMG normalize failed', warnings }, { status: 500 });
  }

  // 2) タイル化して全量拾う
  const tiles: Tile[] = [];
  const maxTilesTotal = Number(process.env.FLYER_MAX_TILES ?? '200');
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
        meta: { pages: pagePngs.length, tiles: 0, elapsedMs: Date.now() - started },
        warnings: [...warnings, 'タイルが生成できませんでした。'],
      },
      { status: 200 }
    );
  }

  // 3) Gemini呼び出し（まずは安全に逐次。速くしたければ並列化する）
  const allItems: FlyerItem[] = [];
  for (let i = 0; i < tiles.length; i++) {
    try {
      const { itemsRaw, rawHead } = await callGeminiForTile({
        apiKey,
        modelName,
        maxOutputTokens,
        tile: tiles[i],
        tileIndexGlobal: i + 1,
        tileCountGlobal: tiles.length,
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
  for (const it of allItems) {
    map.set(makeDedupKey(it), it);
  }

  const items = Array.from(map.values());

  return NextResponse.json({
    items,
    count: items.length,
    meta: {
      model: modelName,
      pages: pagePngs.length,
      tiles: tiles.length,
      elapsedMs: Date.now() - started,
      maxOutputTokens,
    },
    warnings,
  });
}
