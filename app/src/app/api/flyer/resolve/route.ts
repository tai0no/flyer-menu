// src/app/api/flyer/resolve/route.ts
import { NextResponse } from "next/server";
import { chromium } from "playwright";

export const runtime = "nodejs";

type Candidate = {
  kind: "image" | "pdf" | "page";
  url: string;
  title?: string;
  source?: "resolve" | "resolve_pw";
};

type ResolveRequestBody = {
  storeId: "life_kawasaki_oshima" | "aoba_oshima" | "itoyokado_kawasaki";
  pages?: string[];
  pageUrl?: string;
};

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const BAD_PARTS = [
  "thumb",
  "thumbnail",
  "favicon",
  "logo",
  "icon",
  "sprite",
  "banner",
  "btn",
  "button",
  "common",
  "loading",
  "spinner",
  "pixel",
  "tracking",
  "analytics",
  "thumb-size=m",
  "content-width=310",
  "content-height=310",
];

function decodeLoose(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function absolutize(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function looksBad(u: string) {
  const l = u.toLowerCase();
  return BAD_PARTS.some((p) => l.includes(p));
}

function uniq(arr: string[]) {
  return [...new Set(arr)];
}

function scoreShufooImageLike(u: string) {
  const s = u.toLowerCase();
  let score = 0;
  if (s.includes("ipqcache")) score += 90;
  if (s.includes("s-cmn.shufoo.net") || s.includes("cmn.shufoo.net")) score += 70;
  if (s.includes("shufoo")) score += 20;
  if (s.includes("thumb") || s.includes("thumbnail")) score -= 120;
  if (s.includes("thumb-size=m") || s.includes("content-width=310") || s.includes("content-height=310")) score -= 120;
  if (/\.(jpg|jpeg|png|webp)(\?|$)/.test(s)) score += 10;
  return score;
}

function toTokubaiHighRes(urlStr: string) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname.includes("tokubai.co.jp")) return urlStr;
    if (u.pathname.includes("/images/bargain_office_leaflets/")) {
      u.pathname = u.pathname.replace(
        /\/images\/bargain_office_leaflets\/[^/]+\//,
        "/images/bargain_office_leaflets/o=true/"
      );
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}

function extractStateBlockImageUrls(html: string, base: string) {
  const match = html.match(/State[\s\S]*?end/);
  if (!match) return [];

  const block = match[0];
  const urls = block.match(/https?:\/\/[^"'\\\s>]+?\.(?:png|jpe?g|webp)(?:\?[^"'\\\s>]*)?/gi) ?? [];

  return uniq(
    urls
      .map((u) => decodeLoose(u))
      .map((u) => absolutize(u, base))
      .filter((u): u is string => Boolean(u))
  )
    .filter((u) => !looksBad(u))
    .sort((a, b) => scoreShufooImageLike(b) - scoreShufooImageLike(a));
}

async function contentLength(url: string, referer?: string): Promise<number> {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "user-agent": UA,
        ...(referer ? { referer } : {}),
      },
    });

    const cl = r.headers.get("content-length");
    if (cl) return Number(cl) || 0;

    const cr = r.headers.get("content-range");
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) return Number(m[1]) || 0;
    }
  } catch {
    // ignore
  }

  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": UA,
        ...(referer ? { referer } : {}),
        range: "bytes=0-0",
      },
    });

    const cr = r.headers.get("content-range");
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) return Number(m[1]) || 0;
    }

    const cl = r.headers.get("content-length");
    if (cl) return Number(cl) || 0;
  } catch {
    // ignore
  }

  return 0;
}

function extractUrlsFromHtml(html: string, base: string) {
  const s = decodeLoose(html);

  const images: string[] = [];
  const pdfs: string[] = [];

  const metaRe =
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(s))) {
    const u = absolutize(m[1], base);
    if (u) images.push(u);
  }

  const linkRe =
    /<link[^>]+rel=["'](?:image_src|preload)["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(s))) {
    const u = absolutize(m[1], base);
    if (!u) continue;
    if (u.toLowerCase().includes(".pdf")) pdfs.push(u);
    else images.push(u);
  }

  const attrRe =
    /\b(?:src|href|data-src|data-original)=["']([^"']+\.(?:png|jpe?g|webp|pdf)(?:\?[^"']*)?)["']/gi;
  while ((m = attrRe.exec(s))) {
    const u = absolutize(m[1], base);
    if (!u) continue;
    if (u.toLowerCase().includes(".pdf")) pdfs.push(u);
    else images.push(u);
  }

  const urlRe =
    /https?:\/\/[^"'\\\s>]+?\.(?:png|jpe?g|webp|pdf)(?:\?[^"'\\\s>]*)?/gi;
  const found = s.match(urlRe) ?? [];
  for (const raw of found) {
    const u = decodeLoose(raw);
    const abs = absolutize(u, base);
    if (!abs) continue;
    if (abs.toLowerCase().includes(".pdf")) pdfs.push(abs);
    else images.push(abs);
  }

  return {
    images: uniq(images),
    pdfs: uniq(pdfs),
  };
}

function pickItoyokadoViewerPage(pages: string[]) {
  const viewer = pages.find((u) => /\/t\/asp_iframe\/shop\/\d+\/\d+/.test(u));
  return viewer ?? pages[0];
}

/**
 * Shufooは動的なので、描画して “画面に出てるメイン画像” を拾う（最大面積の img を採用）
 */
async function resolveShufooWithPlaywright(targetPage: string, mode: "mainOnly" | "default") {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();

    // 画像レスポンスを拾う（DOMに出ないケース対策）
    const seen: Array<{ url: string; size: number }> = [];
    page.on("response", async (res) => {
      try {
        const url = res.url();
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.startsWith("image/")) return;

        const cl = res.headers()["content-length"];
        const size = cl ? Number(cl) || 0 : 0;

        // サムネっぽいのは落とす
        if (looksBad(url)) return;

        seen.push({ url, size });
      } catch {
        // ignore
      }
    });

    await page.goto(targetPage, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // 動的読み込み待ち
    await page.waitForTimeout(2500);

    if (mode === "mainOnly") {
      // イトーヨーカドー: State〜end のブロックからタイルURL群を拾う（後段で合成）
      const html = await page.content();
      const fromState = extractStateBlockImageUrls(html, targetPage);
      if (fromState.length > 0) return fromState;
    }

    // DOMの img から “最大面積” を取る
    const domImgs = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      return imgs
        .map((img) => {
          const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || "";
          const w = (img as HTMLImageElement).naturalWidth || img.clientWidth || 0;
          const h = (img as HTMLImageElement).naturalHeight || img.clientHeight || 0;
          return { src, w, h, area: w * h };
        })
        .filter((x) => x.src && x.area > 0)
        .sort((a, b) => b.area - a.area)
        .slice(0, 10);
    });

    const domUrls = domImgs.map((x) => x.src);

    // スコアリング：DOM最大面積を最優先、次にレスポンスの content-length
    const candidates = uniq([
      ...domUrls,
      ...seen
        .sort((a, b) => b.size - a.size)
        .map((x) => x.url),
    ]).filter((u) => u && !u.startsWith("data:") && !u.startsWith("blob:") && !looksBad(u));

    // 先頭が “中央上のメイン” になりやすい
    return mode === "mainOnly" ? candidates.slice(0, 1) : candidates.slice(0, 6);
  } finally {
    await browser.close();
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ResolveRequestBody | null;

  if (!body) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const storeId = body.storeId;
  const pages = body.pages ?? (body.pageUrl ? [body.pageUrl] : []);
  if (!storeId || pages.length === 0) {
    return NextResponse.json(
      { error: "storeId & pages/pageUrl are required" },
      { status: 400 }
    );
  }

  const warnings: string[] = [];
  const targetPage =
    storeId === "itoyokado_kawasaki" ? pickItoyokadoViewerPage(pages) : pages[0];

  // まずは軽い（HTML解析）方式
  let html = "";
  try {
    const r = await fetch(targetPage, {
      redirect: "follow",
      headers: { "user-agent": UA },
    });
    html = await r.text();
  } catch (e) {
    return NextResponse.json(
      {
        storeId,
        targetPage,
        candidates: [],
        warnings: [`fetch html failed: ${String(e)}`],
      },
      { status: 200 }
    );
  }

  const { images, pdfs } = extractUrlsFromHtml(html, targetPage);

  const imgCandidates = images
    .filter((u) => !u.startsWith("data:") && !u.startsWith("blob:"))
    .filter((u) => !looksBad(u));

  const pdfCandidates = pdfs.filter((u) => !looksBad(u));

  const checkN = Math.min(imgCandidates.length, 50);
  const scored: Array<{ url: string; size: number }> = [];

  for (let i = 0; i < checkN; i++) {
    const url = imgCandidates[i];
    const size = await contentLength(url, targetPage);
    scored.push({ url, size });
  }

  scored.sort((a, b) => b.size - a.size);

  // 本体っぽい最低サイズ閾値（サムネ除外）
  let picked = scored
    .filter((x) => x.size === 0 || x.size > 180_000)
    .slice(0, 6)
    .map((x) => x.url);

  if (storeId === "itoyokado_kawasaki") {
    // イトーヨーカドーは常に Playwright で State〜end のメイン画像を1枚取得
    try {
      const pwPicked = await resolveShufooWithPlaywright(targetPage, "mainOnly");
      if (pwPicked.length > 0) {
        picked = pwPicked;
      } else if (picked.length === 0) {
        warnings.push("Playwrightでもメイン画像URLを取得できませんでした。");
      }
    } catch (e) {
      warnings.push(`Playwright resolve failed: ${String(e)}`);
    }
  }

  if (storeId === "life_kawasaki_oshima") {
    picked = picked.map((u) => toTokubaiHighRes(u));
  }

  const candidates: Candidate[] = [
    ...pdfCandidates.slice(0, 3).map((u, i) => ({
      kind: "pdf" as const,
      url: u,
      title: `PDF候補 ${i + 1}`,
      source: "resolve" as const,
    })),
    ...picked.map((u, i) => ({
      kind: "image" as const,
      url: u,
      title: `メイン画像候補 ${i + 1}`,
      source: storeId === "itoyokado_kawasaki" ? ("resolve_pw" as const) : ("resolve" as const),
    })),
  ];

  return NextResponse.json(
    {
      storeId,
      targetPage,
      candidates,
      warnings,
      meta: {
        foundImages: imgCandidates.length,
        checked: checkN,
        picked: picked.length,
      },
    },
    { status: 200 }
  );
}
