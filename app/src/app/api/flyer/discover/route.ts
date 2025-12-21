// src/app/api/flyer/discover/route.ts
import { NextResponse } from 'next/server';

type StoreId = 'life_kawasaki_oshima' | 'aoba_oshima' | 'itoyokado_kawasaki';

type Candidate = {
  kind: 'image' | 'pdf' | 'page';
  url: string;
  title: string;
  source: 'fixed' | 'scrape';
};

type DiscoverResponse = {
  storeId: StoreId;
  candidates: Candidate[];
  warnings: string[];
};

const STORE_URLS: Record<StoreId, string> = {
  life_kawasaki_oshima: 'https://store.lifecorp.jp/detail/east624/',
  aoba_oshima: 'https://www.bicrise.com/ooshima/',
  itoyokado_kawasaki: 'https://stores.itoyokado.co.jp/detail/547/',
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

function decodeLooseAmp(input: string) {
  return input.replace(/\\u0026/g, '&');
}

function stripTags(input: string) {
  return input.replace(/<[^>]+>/g, '').trim();
}

function toAbsUrl(raw: string, baseUrl: string) {
  const s = decodeLooseAmp(decodeHtmlEntities(raw.trim()));
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return null;
  }
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
  if (m) out.push(...m.map((u) => decodeLooseAmp(decodeHtmlEntities(u))));
  return out;
}

function extractMetaImages(html: string, baseUrl: string) {
  // og:image / twitter:image を最優先（ここが “ページ中央上の大きい画像” を指してることが多い）
  const out: string[] = [];
  const re = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const abs = toAbsUrl(m[1], baseUrl);
    if (abs) out.push(abs);
  }
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

function extractTokubaiWidgetUrls(html: string, baseUrl: string) {
  const out: string[] = [];
  const re = /https?:\/\/widgets\.tokubai\.co\.jp\/\d+\/leaflet_widget[^"'<>\\\s]*/gi;
  const matches = html.match(re) ?? [];
  for (const raw of matches) {
    const abs = toAbsUrl(raw, baseUrl);
    if (abs) out.push(abs);
  }
  return uniq(out);
}

function uniq(xs: string[]) {
  return Array.from(new Set(xs));
}

function isImageOrPdf(u: string) {
  const s = u.toLowerCase();
  return s.endsWith('.pdf') || s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') || s.endsWith('.webp');
}

function classifyCandidate(url: string): Candidate | null {
  const u = url.toLowerCase();

  if (u.endsWith('.pdf')) return { kind: 'pdf', url, title: 'PDFチラシ候補', source: 'scrape' };
  if (u.endsWith('.jpg') || u.endsWith('.jpeg') || u.endsWith('.png') || u.endsWith('.webp'))
    return { kind: 'image', url, title: '画像チラシ候補', source: 'scrape' };

  if (u.includes('shufoo') || u.includes('chirashi') || u.includes('asp_iframe'))
    return { kind: 'page', url, title: '店舗チラシページ', source: 'scrape' };

  return null;
}

async function fetchHtml(url: string) {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

function uniqByUrl(cands: Candidate[]) {
  const map = new Map<string, Candidate>();
  for (const c of cands) {
    const key = decodeLooseAmp(c.url);
    map.set(key, { ...c, url: key });
  }
  return Array.from(map.values());
}

/**
 * Shufoo の “詳細ページ” を拾う（/shop/{id}/{flyerId}）
 * list しか取れない場合は list HTML から flyerId を抽出して詳細URLを作る。
 */
async function findShufooDetailPageUrl(args: { storeHtml: string; storeUrl: string }): Promise<string | null> {
  const { storeHtml, storeUrl } = args;

  // 1) カード情報から「最新のチラシ」を選ぶ
  const latestFromCards = pickLatestShufooCardUrl(storeHtml, storeUrl);
  if (latestFromCards) return latestFromCards;

  const urls = uniq([
    ...extractAttrUrls(storeHtml, storeUrl),
    ...extractRawUrls(storeHtml),
    ...extractCssUrls(storeHtml, storeUrl),
  ]);

  // 1) すでに詳細ページURLが埋まっているケース
  const detailRe = /https?:\/\/asp\.shufoo\.net\/t\/asp_iframe\/shop\/\d+\/\d+(?:\?[^"'<>]*)?/i;
  const detail = urls.find((u) => detailRe.test(u));
  if (detail) return detail;

  // 2) list URL を拾って、そこから flyerId を抜く
  const listRe = /https?:\/\/asp\.shufoo\.net\/t\/asp_iframe\/shop\/\d+\/list(?:\?[^"'<>]*)?/i;
  const listUrl = urls.find((u) => listRe.test(u));
  if (!listUrl) return null;

  try {
    const html = await fetchHtml(listUrl);

    // list HTML 内に /shop/{shopId}/{flyerId} が埋まってることが多い
    const m = html.match(/\/t\/asp_iframe\/shop\/(\d+)\/(\d+)(?:\?[^"'<>]*)?/);
    if (!m) return null;

    const shopId = m[1];
    const flyerId = m[2];

    // できるだけ “ビュー付き” パラメータを付ける（ユーザーが見ている中央上のやつ）
    const detailUrl = `https://asp.shufoo.net/t/asp_iframe/shop/${shopId}/${flyerId}?lp-chirashi=true&lp-timeline=true&lp-pickup=true&lp-coupon=true&lp-event=true&lp-shop-detail=false&un=IY`;
    return detailUrl;
  } catch {
    return null;
  }
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

function parseLifeDurationStart(text: string) {
  const normalized = stripTags(text)
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const m = normalized.match(/(\d{4})年(\d{1,2})月(\d{1,2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day).getTime();
}

type LifeLeafletPickResult = {
  urls: string[];
  debug: {
    totalCards: number;
    parsedCards: number;
    withDates: number;
    withoutDates: number;
    latestCount: number;
  };
};

function pickLatestLifeLeaflets(storeHtml: string, storeUrl: string): LifeLeafletPickResult {
  const cardRe = /<a[^>]*(?:class="[^"]*leaflet[^"]*"[^>]*|href="[^"]*\/leaflet_widget\/click[^"]*"[^>]*)>[\s\S]*?<\/a>/gi;
  const cards = storeHtml.match(cardRe) ?? [];
  if (cards.length === 0) {
    return {
      urls: [],
      debug: { totalCards: 0, parsedCards: 0, withDates: 0, withoutDates: 0, latestCount: 0 },
    };
  }

  type Card = { href: string; img: string; start: number | null };
  const parsed: Card[] = [];
  let withDatesCount = 0;

  for (const card of cards) {
    const hrefMatch = card.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const imgMatch = card.match(/\bimg[^>]*src\s*=\s*["']([^"']+)["']/i);
    const durationMatch = card.match(/<div[^>]*class="[^"]*duration[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!hrefMatch || !imgMatch) continue;
    const hrefAbs = toAbsUrl(hrefMatch[1], storeUrl);
    const imgAbs = toAbsUrl(imgMatch[1], storeUrl);
    if (!hrefAbs || !imgAbs) continue;
    const durationSource = durationMatch ? durationMatch[1] : card;
    const start = parseLifeDurationStart(durationSource);
    if (start != null) withDatesCount += 1;
    parsed.push({ href: hrefAbs, img: imgAbs, start });
  }

  const withDates = parsed.filter((c) => c.start != null) as Array<Card & { start: number }>;
  if (withDates.length === 0) {
    return {
      urls: [],
      debug: {
        totalCards: cards.length,
        parsedCards: parsed.length,
        withDates: 0,
        withoutDates: parsed.length,
        latestCount: 0,
      },
    };
  }

  const maxStart = Math.max(...withDates.map((c) => c.start));
  const latest = withDates.filter((c) => c.start === maxStart);

  return {
    urls: latest.map((c) => toTokubaiHighRes(c.img)),
    debug: {
      totalCards: cards.length,
      parsedCards: parsed.length,
      withDates: withDatesCount,
      withoutDates: parsed.length - withDates.length,
      latestCount: latest.length,
    },
  };
}

function parseStartDateFromTitle(title: string) {
  const normalized = decodeLooseAmp(decodeHtmlEntities(title));
  const m = normalized.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  const now = new Date();
  const year = now.getFullYear();
  return new Date(year, month - 1, day).getTime();
}

function toShufooAbsUrl(href: string, storeUrl: string) {
  const cleaned = decodeLooseAmp(decodeHtmlEntities(href));
  if (cleaned.startsWith('/t/asp_iframe/')) {
    return `https://asp.shufoo.net${cleaned}`;
  }
  return toAbsUrl(cleaned, storeUrl);
}

function pickLatestShufooCardUrl(storeHtml: string, storeUrl: string) {
  const cardRe = /<a[^>]*class="[^"]*shufoo-card--chirashi[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  const matches = storeHtml.match(cardRe) ?? [];
  if (matches.length === 0) return null;

  let bestUrl: string | null = null;
  let bestTs = -Infinity;

  for (const block of matches) {
    const hrefMatch = block.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const titleMatch = block.match(/<div[^>]*class="[^"]*shufoo-card__title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!hrefMatch) continue;
    const abs = toShufooAbsUrl(hrefMatch[1], storeUrl);
    if (!abs) continue;
    const titleText = titleMatch ? stripTags(titleMatch[1]) : '';
    const ts = titleText ? parseStartDateFromTitle(titleText) : null;
    if (ts == null) continue;
    if (ts > bestTs) {
      bestTs = ts;
      bestUrl = abs;
    }
  }

  return bestUrl;
}

function scoreShufooImage(u: string) {
  const s = u.toLowerCase();
  let score = 0;

  if (s.includes('og:image') || s.includes('twitter:image')) score += 30;
  if (s.includes('s-cmn.shufoo.net') || s.includes('cmn.shufoo.net')) score += 80;
  if (s.includes('shufoo')) score += 30;

  // “小さいサムネ”っぽい語を強めに減点
  if (s.includes('thumb') || s.includes('thumbnail') || s.includes('btn') || s.includes('icon')) score -= 80;
  if (s.includes('thumb-size=m') || s.includes('content-width=310') || s.includes('content-height=310')) score -= 80;

  // 画像拡張子
  if (s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') || s.endsWith('.webp')) score += 20;

  return score;
}

async function tryResolveMainImageFromShufooPage(pageUrl: string) {
  // discover段階で “大きい画像” が取れれば image候補として追加する
  const warnings: string[] = [];
  try {
    const html = await fetchHtml(pageUrl);

    const metaImgs = extractMetaImages(html, pageUrl);
    const urls = uniq([...metaImgs, ...extractRawUrls(html), ...extractAttrUrls(html, pageUrl), ...extractCssUrls(html, pageUrl)]);
    const imgUrls = urls.filter((u) => {
      const s = u.toLowerCase();
      return (
        (s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') || s.endsWith('.webp')) &&
        (s.includes('shufoo.net') || s.includes('s-cmn.shufoo.net') || s.includes('cmn.shufoo.net'))
      );
    });

    if (imgUrls.length === 0) return { imageUrl: null as string | null, warnings: ['Shufooページから画像URLを見つけられませんでした。'] };

    imgUrls.sort((a, b) => scoreShufooImage(b) - scoreShufooImage(a));
    const best = imgUrls[0];

    // “サムネっぽい”なら警告
    if (best.toLowerCase().includes('thumb')) {
      warnings.push('大きい画像URLを取れませんでした（サムネしか拾えてない可能性）。必要なら Playwright方式に切り替えます。');
    }

    return { imageUrl: best, warnings };
  } catch (e: any) {
    return { imageUrl: null, warnings: [`Shufooページの取得/解析に失敗: ${String(e?.message ?? e)}`] };
  }
}

export async function POST(req: Request) {
  const warnings: string[] = [];

  try {
    const body = (await req.json()) as { storeId?: StoreId };
    const storeId = body.storeId;

    if (!storeId || !(storeId in STORE_URLS)) {
      return NextResponse.json({ error: 'invalid storeId' }, { status: 400 });
    }

    // あおばは固定（安定）
    if (storeId === 'aoba_oshima') {
      const candidates: Candidate[] = [
        { kind: 'image', url: 'https://www.bicrise.com/flyer/ooshima-01.jpg', title: 'あおば大島 チラシ 1', source: 'fixed' },
        { kind: 'image', url: 'https://www.bicrise.com/flyer/ooshima-02.jpg', title: 'あおば大島 チラシ 2', source: 'fixed' },
      ];
      const resp: DiscoverResponse = { storeId, candidates, warnings };
      return NextResponse.json(resp);
    }

    const storeUrl = STORE_URLS[storeId];
    const storeHtml = await fetchHtml(storeUrl);

    // --- イトーヨーカドー: “中央上の大きい画像” を優先して取る ---
    if (storeId === 'itoyokado_kawasaki') {
      const detailUrl = await findShufooDetailPageUrl({ storeHtml, storeUrl });

      const candidates: Candidate[] = [];
      const normalizedDetailUrl = detailUrl ? decodeLooseAmp(detailUrl) : null;

      if (normalizedDetailUrl) {
        // 1) まず “詳細ページ（ビュー）” を最優先で出す
        candidates.push({
          kind: 'page',
          url: normalizedDetailUrl,
          title: '店舗チラシページ（メインビュー）',
          source: 'scrape',
        });

        // 2) 可能なら discover 時点で og:image 等から “大きい画像” を拾って image候補として追加
        const resolved = await tryResolveMainImageFromShufooPage(normalizedDetailUrl);
        warnings.push(...resolved.warnings);

        if (resolved.imageUrl) {
          candidates.unshift({ kind: 'image', url: resolved.imageUrl, title: 'メインチラシ画像（推定）', source: 'scrape' });
        }
      } else {
        warnings.push('Shufoo詳細ページURLを見つけられませんでした。');
      }

      // フォールバックとして、元ページ内の “shufoo/chirashiっぽいURL” も一応拾う
      const urls = uniq([
        ...extractAttrUrls(storeHtml, storeUrl),
        ...extractRawUrls(storeHtml),
        ...extractCssUrls(storeHtml, storeUrl),
      ]);

      const pageFallback = urls
        .map((u) => classifyCandidate(u))
        .filter((x): x is Candidate => Boolean(x))
        .filter((c) => c.kind === 'page');

      // list は “サムネ一覧”になりがちなので、後ろに回す（重要）
      const filteredFallback = normalizedDetailUrl
        ? pageFallback.filter((c) => !c.url.toLowerCase().includes('/list'))
        : pageFallback;

      const sortedFallback = filteredFallback.sort((a, b) => {
        const al = a.url.toLowerCase();
        const bl = b.url.toLowerCase();
        const aIsList = al.includes('/list');
        const bIsList = bl.includes('/list');
        if (aIsList === bIsList) return 0;
        return aIsList ? 1 : -1;
      });

      candidates.push(...sortedFallback);

      const resp: DiscoverResponse = {
        storeId,
        candidates: uniqByUrl(candidates)
          .sort((a, b) => {
            if (a.kind === b.kind) return 0;
            if (a.kind === 'image') return -1;
            if (b.kind === 'image') return 1;
            if (a.kind === 'page') return -1;
            return 1;
          })
          .slice(0, 30),
        warnings,
      };
      return NextResponse.json(resp);
    }

    // --- ライフ: 既存の汎用スクレイプ（ここは後で詰める） ---
    if (storeId === 'life_kawasaki_oshima') {
      const latest = pickLatestLifeLeaflets(storeHtml, storeUrl);
      if (latest.urls.length > 0) {
        const candidates: Candidate[] = latest.urls
          .filter(isLifeLeafletUrl)
          .map((u, i) => ({
            kind: 'image',
            url: u,
            title: `最新チラシ画像 ${i + 1}`,
            source: 'scrape',
          }));
        const resp: DiscoverResponse = { storeId, candidates: uniqByUrl(candidates).slice(0, 10), warnings };
        return NextResponse.json(resp);
      }

      const widgetUrls = extractTokubaiWidgetUrls(storeHtml, storeUrl);
      const rawUrls = uniq([
        ...extractAttrUrls(storeHtml, storeUrl),
        ...extractRawUrls(storeHtml),
        ...extractCssUrls(storeHtml, storeUrl),
      ]);
      const tokubaiImages = rawUrls.filter(isLifeLeafletUrl).map(toTokubaiHighRes);

      if (widgetUrls.length > 0 || tokubaiImages.length > 0) {
        const candidates: Candidate[] = [
          ...tokubaiImages.map((u, i) => ({
            kind: 'image' as const,
            url: u,
            title: `チラシ画像候補 ${i + 1}`,
            source: 'scrape' as const,
          })),
          ...widgetUrls.map((u, i) => ({
            kind: 'page' as const,
            url: u,
            title: `チラシウィジェット ${i + 1}`,
            source: 'scrape' as const,
          })),
        ];
        const resp: DiscoverResponse = { storeId, candidates: uniqByUrl(candidates).slice(0, 30), warnings };
        return NextResponse.json(resp);
      }

      const hasLeafletLink = /\/leaflet_widget\/click/.test(storeHtml);
      const tokubaiCount = (storeHtml.match(/image\.tokubai\.co\.jp\/images\/bargain_office_leaflets/gi) ?? []).length;
      warnings.push(
        `leaflet_widget から最新チラシを特定できませんでした。cards=${latest.debug.totalCards}, parsed=${latest.debug.parsedCards}, withDates=${latest.debug.withDates}, latest=${latest.debug.latestCount}, hasLeafletLink=${hasLeafletLink}, tokubaiImgs=${tokubaiCount}, widgetUrls=${widgetUrls.length}`
      );
      const resp: DiscoverResponse = { storeId, candidates: [], warnings };
      return NextResponse.json(resp);
    }

    const urls = uniq([
      ...extractAttrUrls(storeHtml, storeUrl),
      ...extractRawUrls(storeHtml),
      ...extractCssUrls(storeHtml, storeUrl),
    ]);

    const cands = urls
      .map((u) => classifyCandidate(u))
      .filter((x): x is Candidate => Boolean(x));

    const candidates = uniqByUrl(cands).slice(0, 30);

    if (storeId === 'life_kawasaki_oshima') {
      const hasSomething = candidates.length > 0;
      if (!hasSomething) warnings.push('Webチラシの直URL/ページURLを見つけられませんでした（HTML構造が想定と違う可能性）。');
    }

    const resp: DiscoverResponse = { storeId, candidates, warnings };
    return NextResponse.json(resp);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
