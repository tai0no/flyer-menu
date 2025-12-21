// src/app/lib/flyerDiscover.ts
export type StoreId = "life_kawasaki_oshima" | "aoba_oshima" | "itoyokado_kawasaki";

export type FlyerCandidate = {
  kind: "image" | "pdf" | "page";
  url: string;
  title?: string;
  source: "fixed" | "scrape";
};

export type DiscoverResult = {
  storeId: StoreId;
  candidates: FlyerCandidate[];
  warnings: string[];
};

const STORE_HOME: Record<StoreId, { label: string; url: string }> = {
  life_kawasaki_oshima: { label: "ライフ 川崎大島店", url: "https://store.lifecorp.jp/detail/east624/" },
  aoba_oshima: { label: "食品館あおば 大島店", url: "https://www.bicrise.com/ooshima/" },
  itoyokado_kawasaki: { label: "イトーヨーカドー 川崎店", url: "https://stores.itoyokado.co.jp/detail/547/" },
};

function uniqByUrl(list: FlyerCandidate[]) {
  const seen = new Set<string>();
  const out: FlyerCandidate[] = [];
  for (const x of list) {
    if (seen.has(x.url)) continue;
    seen.add(x.url);
    out.push(x);
  }
  return out;
}

// HTMLからhrefを抽出（cheerio無しの超軽量版）
function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    hrefs.push(m[1]);
  }
  return hrefs;
}

// 相対URLを絶対URLへ
function toAbs(base: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      // 一部サイトで弾かれにくいように最低限
      "user-agent": "Mozilla/5.0 (compatible; flyer-menu-mvp/1.0)",
      "accept": "text/html,application/xhtml+xml",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

export async function discoverFlyerCandidates(storeId: StoreId): Promise<DiscoverResult> {
  const warnings: string[] = [];
  const candidates: FlyerCandidate[] = [];

  // 1) あおば：直画像URLが分かっている（固定）
  if (storeId === "aoba_oshima") {
    candidates.push(
      { kind: "image", url: "https://www.bicrise.com/flyer/ooshima-01.jpg", title: "あおば大島 チラシ 1", source: "fixed" },
      { kind: "image", url: "https://www.bicrise.com/flyer/ooshima-02.jpg", title: "あおば大島 チラシ 2", source: "fixed" }
    );
    return { storeId, candidates: uniqByUrl(candidates), warnings };
  }

  // 2) イトーヨーカドー：店舗ページ内の「チラシを見る」(asp.shufoo.net) を拾う
  if (storeId === "itoyokado_kawasaki") {
    const home = STORE_HOME[storeId].url;
    const html = await fetchHtml(home);
    const hrefs = extractHrefs(html).map((h) => toAbs(home, h));

    const shufooLinks = hrefs.filter((h) => /asp\.shufoo\.net\/t\/asp_iframe\/shop\//i.test(h));
    const detail = shufooLinks.find((h) => /\/t\/asp_iframe\/shop\/\d+\/\d+/i.test(h));
    const list = shufooLinks.find((h) => /\/t\/asp_iframe\/shop\/\d+\/list/i.test(h));

    const picked = detail ?? list;
    if (picked) {
      candidates.push({ kind: "page", url: picked, title: "店舗チラシページ（Shufoo）", source: "scrape" });
      warnings.push("Shufooページは動的です。次ステップで、ここから画像/PDF直URLへ“展開”します。");
      if (!detail && list) {
        warnings.push("list（サムネ一覧）URLしか見つかりませんでした。小さい画像が混ざる可能性があります。");
      }
    } else {
      warnings.push("店舗ページからチラシページURLを見つけられませんでした。ページ構造が変わった可能性があります。");
    }
    return { storeId, candidates: uniqByUrl(candidates), warnings };
  }

  // 3) ライフ：店舗ページが動的っぽいので、まずは候補探索（pdf/jpg/pngを探す）
  //   ※ 見つからない場合は “動的対応(Playwrightなど)” に進む
  if (storeId === "life_kawasaki_oshima") {
    const home = STORE_HOME[storeId].url;
    const html = await fetchHtml(home);
    const hrefs = extractHrefs(html).map((h) => toAbs(home, h));

    // PDF/画像っぽいリンクを拾う（見つかればラッキー）
    for (const u of hrefs) {
      if (/\.(pdf)(\?|#|$)/i.test(u)) {
        candidates.push({ kind: "pdf", url: u, title: "WebチラシPDF候補", source: "scrape" });
      } else if (/\.(png|jpe?g)(\?|#|$)/i.test(u)) {
        candidates.push({ kind: "image", url: u, title: "Webチラシ画像候補", source: "scrape" });
      }
    }

    if (candidates.length === 0) {
      warnings.push(
        "ライフのWebチラシは店舗ページ上で動的に読み込まれている可能性が高いです。次ステップでPlaywright等で“動的に展開して画像URLを回収”する方式にします。"
      );
    }
    return { storeId, candidates: uniqByUrl(candidates), warnings };
  }

  return { storeId, candidates: [], warnings: ["未対応のstoreIdです。"] };
}
