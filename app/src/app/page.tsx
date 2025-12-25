'use client';

import { useMemo, useRef, useState } from 'react';

type Store = {
  id: 'life_kawasaki_oshima' | 'aoba_oshima' | 'itoyokado_kawasaki';
  label: string;
  url: string;
};

type MenuDay = {
  dayLabel: string;
  title: string;
  points: string[];
  suggestedIngredients: string[];
};

// Flyer抽出のレスポンスは、今後フィールドが増える想定なのでゆるめに持つ
type FlyerExtractResponse = {
  store_name?: string;
  period?: string;
  items?: unknown[];
  warnings?: string[];
  count?: number;
  meta?: unknown;
  [key: string]: unknown;
};

type FlyerDiscoverResponse = {
  storeId: Store['id'];
  candidates: Array<{
    kind: 'image' | 'pdf' | 'page';
    url: string;
    title?: string;
    source?: string;
  }>;
  warnings: string[];
};

type FlyerResolveResponse = {
  storeId: Store['id'];
  pageUrl: string;
  candidates: Array<{
    kind: 'image' | 'pdf';
    url: string;
    title?: string;
    source?: string;
  }>;
  warnings: string[];
};

type StoreFetchState = {
  state: 'idle' | 'loading' | 'done' | 'error';
  message?: string;
};

const STORES: Store[] = [
  {
    id: 'life_kawasaki_oshima',
    label: 'ライフ 川崎大島店',
    url: 'https://store.lifecorp.jp/detail/east624/',
  },
  {
    id: 'aoba_oshima',
    label: '食品館あおば 大島店',
    url: 'https://www.bicrise.com/ooshima/',
  },
  {
    id: 'itoyokado_kawasaki',
    label: 'イトーヨーカドー 川崎店',
    url: 'https://stores.itoyokado.co.jp/detail/547/',
  },
];

const AUTO_MAX_TILES = 80;
const AUTO_MAX_TILES_LIGHT = 40;
const AUTO_MAX_URLS_LIGHT = 2;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function Spinner({ title }: { title?: string }) {
  return (
    <span className="inline-flex items-center" title={title}>
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
    </span>
  );
}

function decodeLooseAmp(url: string) {
  // discoverの候補に \u0026 が混ざるケース対策
  return url.replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
}

function pickBestPageUrl(urls: string[]) {
  // 優先：asp.shufoo.net の shop/xxx/yyy で lp-chirashi が付いてるやつ
  const preferred = urls.find(
    (u) => u.includes('asp.shufoo.net') && u.includes('/shop/') && u.includes('lp-chirashi')
  );
  return preferred ?? urls[0];
}

export default function Page() {
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<Store['id']>>(new Set());
  const [fridgeText, setFridgeText] = useState('');
  const [requestText, setRequestText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MenuDay[] | null>(null);

  // 手動アップロード（PDF/画像）用（既存）
  const [flyerFile, setFlyerFile] = useState<File | null>(null);
  const [flyerExtracting, setFlyerExtracting] = useState(false);
  const [flyerError, setFlyerError] = useState<string | null>(null);
  const [flyerResult, setFlyerResult] = useState<FlyerExtractResponse | null>(null);
  const [flyerIngredientExtracting, setFlyerIngredientExtracting] = useState(false);
  const [flyerIngredientError, setFlyerIngredientError] = useState<string | null>(null);
  const [flyerIngredientResult, setFlyerIngredientResult] = useState<FlyerExtractResponse | null>(null);
  const flyerAbortRef = useRef<AbortController | null>(null);
  const flyerIngredientAbortRef = useRef<AbortController | null>(null);
  const [flyerMode, setFlyerMode] = useState<'all' | 'ingredients' | null>(null);

  // ✅ 自動取得（チェックONでWeb→discover→(resolve)→extract-url）
  const [autoFlyerByStore, setAutoFlyerByStore] = useState<Partial<Record<Store['id'], FlyerExtractResponse>>>({});
  const [autoStateByStore, setAutoStateByStore] = useState<Record<Store['id'], StoreFetchState>>({
    life_kawasaki_oshima: { state: 'idle' },
    aoba_oshima: { state: 'idle' },
    itoyokado_kawasaki: { state: 'idle' },
  });
  const [autoModeByStore, setAutoModeByStore] = useState<Record<Store['id'], 'all' | 'ingredients' | null>>({
    life_kawasaki_oshima: null,
    aoba_oshima: null,
    itoyokado_kawasaki: null,
  });

  const abortRef = useRef<Partial<Record<Store['id'], AbortController>>>({});

  const selectedStores = useMemo(() => {
    return STORES.filter((s) => selectedStoreIds.has(s.id));
  }, [selectedStoreIds]);

  const canGenerate =
    selectedStores.length > 0 && fridgeText.trim().length > 0 && requestText.trim().length > 0 && !isGenerating;

  const getAutoItemsCount = (storeId: Store['id']) => {
    const it = autoFlyerByStore[storeId]?.items;
    return Array.isArray(it) ? it.length : 0;
  };

  const startAutoFetchForStore = async (storeId: Store['id']) => {
    // 既存の実行があれば中断
    const prev = abortRef.current[storeId];
    if (prev) prev.abort();

    const ac = new AbortController();
    abortRef.current[storeId] = ac;

    setAutoStateByStore((prevState) => ({
      ...prevState,
      [storeId]: { state: 'loading' },
    }));
    setAutoModeByStore((prevMode) => ({
      ...prevMode,
      [storeId]: 'all',
    }));

    try {
      // 1) discover（チラシ候補URL取得）
      const dRes = await fetch('/api/flyer/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storeId }),
        signal: ac.signal,
      });

      const dJson = (await dRes.json().catch(() => null)) as FlyerDiscoverResponse | null;

      if (!dRes.ok || !dJson) {
        throw new Error(dJson ? JSON.stringify(dJson) : `discover failed (${dRes.status})`);
      }

      // 直URL（image/pdf）
      const urls: string[] = (dJson.candidates ?? [])
        .filter((c) => c.kind === 'image' || c.kind === 'pdf')
        .map((c) => decodeLooseAmp(c.url));

      // page候補（Shufoo等）
      const pageUrls: string[] = (dJson.candidates ?? [])
        .filter((c) => c.kind === 'page')
        .map((c) => decodeLooseAmp(c.url));

      // 2) イトーヨーカドーは resolve を挟まない（Playwright不要化）
      const shouldResolve = storeId !== 'itoyokado_kawasaki' && urls.length === 0 && pageUrls.length > 0;
      if (shouldResolve) {
        const bestPage = pickBestPageUrl(pageUrls);

        const rRes = await fetch('/api/flyer/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ storeId, pageUrl: bestPage }),
          signal: ac.signal,
        });

        const rJson = (await rRes.json().catch(() => null)) as FlyerResolveResponse | null;

        if (!rRes.ok || !rJson) {
          throw new Error(rJson ? JSON.stringify(rJson) : `resolve failed (${rRes.status})`);
        }

        let resolvedUrls: string[] = (rJson.candidates ?? [])
          .filter((c) => c.kind === 'image' || c.kind === 'pdf')
          .map((c) => decodeLooseAmp(c.url));

        if (storeId === 'life_kawasaki_oshima') {
          resolvedUrls = resolvedUrls.slice(0, 2);
        }

        if (resolvedUrls.length === 0) {
          setAutoStateByStore((prevState) => ({
            ...prevState,
            [storeId]: {
              state: 'error',
              message:
                (rJson.warnings?.[0] ?? '') ||
                'チラシページは取得できたが、画像/PDF URLに展開できませんでした（動的の可能性）',
            },
          }));
          return;
        }

        urls.length = 0;
        urls.push(...resolvedUrls);
      } else if (storeId === 'itoyokado_kawasaki' && pageUrls.length > 0) {
        urls.push(...pageUrls);
      }

      if (urls.length === 0) {
        setAutoStateByStore((prevState) => ({
          ...prevState,
          [storeId]: { state: 'error', message: 'チラシ候補URLが見つかりませんでした。' },
        }));
        return;
      }

      // 3) extract-url（URL画像/PDFをサーバーが取得→Gemini抽出）
      const maxTiles = storeId === 'life_kawasaki_oshima' || storeId === 'aoba_oshima' ? AUTO_MAX_TILES_LIGHT : AUTO_MAX_TILES;
      if (storeId === 'life_kawasaki_oshima' || storeId === 'aoba_oshima') {
        urls.length = Math.min(urls.length, AUTO_MAX_URLS_LIGHT);
      }

      const eRes = await fetch('/api/flyer/extract-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storeId, urls, mode: 'all', maxTiles }),
        signal: ac.signal,
      });

      const eJson = (await eRes.json().catch(() => null)) as FlyerExtractResponse | null;

      if (!eRes.ok || !eJson || typeof eJson !== 'object') {
        throw new Error(eJson ? JSON.stringify(eJson) : `extract-url failed (${eRes.status})`);
      }

      // 結果保存（店舗ごと）
      setAutoFlyerByStore((prevMap) => ({
        ...prevMap,
        [storeId]: eJson,
      }));

      setAutoStateByStore((prevState) => ({
        ...prevState,
        [storeId]: { state: 'done' },
      }));
    } catch (e: any) {
      if (e?.name === 'AbortError') return;

      console.error(e);
      setAutoStateByStore((prevState) => ({
        ...prevState,
        [storeId]: { state: 'error', message: e?.message ?? '自動取得に失敗しました' },
      }));
    }
  };

  const startAutoFetchIngredientsForStore = async (storeId: Store['id']) => {
    const prev = abortRef.current[storeId];
    if (prev) prev.abort();

    const ac = new AbortController();
    abortRef.current[storeId] = ac;

    setAutoStateByStore((prevState) => ({
      ...prevState,
      [storeId]: { state: 'loading' },
    }));
    setAutoModeByStore((prevMode) => ({
      ...prevMode,
      [storeId]: 'ingredients',
    }));

    try {
      const dRes = await fetch('/api/flyer/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storeId }),
        signal: ac.signal,
      });

      const dJson = (await dRes.json().catch(() => null)) as FlyerDiscoverResponse | null;

      if (!dRes.ok || !dJson) {
        throw new Error(dJson ? JSON.stringify(dJson) : `discover failed (${dRes.status})`);
      }

      const urls: string[] = (dJson.candidates ?? [])
        .filter((c) => c.kind === 'image' || c.kind === 'pdf')
        .map((c) => decodeLooseAmp(c.url));

      const pageUrls: string[] = (dJson.candidates ?? [])
        .filter((c) => c.kind === 'page')
        .map((c) => decodeLooseAmp(c.url));

      const shouldResolve = storeId !== 'itoyokado_kawasaki' && urls.length === 0 && pageUrls.length > 0;
      if (shouldResolve) {
        const bestPage = pickBestPageUrl(pageUrls);

        const rRes = await fetch('/api/flyer/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ storeId, pageUrl: bestPage }),
          signal: ac.signal,
        });

        const rJson = (await rRes.json().catch(() => null)) as FlyerResolveResponse | null;

        if (!rRes.ok || !rJson) {
          throw new Error(rJson ? JSON.stringify(rJson) : `resolve failed (${rRes.status})`);
        }

        let resolvedUrls: string[] = (rJson.candidates ?? [])
          .filter((c) => c.kind === 'image' || c.kind === 'pdf')
          .map((c) => decodeLooseAmp(c.url));

        if (storeId === 'life_kawasaki_oshima') {
          resolvedUrls = resolvedUrls.slice(0, 2);
        }

        if (resolvedUrls.length === 0) {
          setAutoStateByStore((prevState) => ({
            ...prevState,
            [storeId]: {
              state: 'error',
              message:
                (rJson.warnings?.[0] ?? '') ||
                'チラシページは取得できたが、画像/PDF URLに展開できませんでした（動的の可能性）',
            },
          }));
          return;
        }

        urls.length = 0;
        urls.push(...resolvedUrls);
      } else if (storeId === 'itoyokado_kawasaki' && pageUrls.length > 0) {
        urls.push(...pageUrls);
      }

      if (urls.length === 0) {
        setAutoStateByStore((prevState) => ({
          ...prevState,
          [storeId]: { state: 'error', message: 'チラシ候補URLが見つかりませんでした。' },
        }));
        return;
      }

      const maxTiles = storeId === 'life_kawasaki_oshima' || storeId === 'aoba_oshima' ? AUTO_MAX_TILES_LIGHT : AUTO_MAX_TILES;
      if (storeId === 'life_kawasaki_oshima' || storeId === 'aoba_oshima') {
        urls.length = Math.min(urls.length, AUTO_MAX_URLS_LIGHT);
      }

      const eRes = await fetch('/api/flyer/extract-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storeId, urls, mode: 'ingredients', maxTiles }),
        signal: ac.signal,
      });

      const eJson = (await eRes.json().catch(() => null)) as FlyerExtractResponse | null;

      if (!eRes.ok || !eJson || typeof eJson !== 'object') {
        throw new Error(eJson ? JSON.stringify(eJson) : `extract-url failed (${eRes.status})`);
      }

      setAutoFlyerByStore((prevMap) => ({
        ...prevMap,
        [storeId]: eJson,
      }));

      setAutoStateByStore((prevState) => ({
        ...prevState,
        [storeId]: { state: 'done' },
      }));
    } catch (e: any) {
      if (e?.name === 'AbortError') return;

      console.error(e);
      setAutoStateByStore((prevState) => ({
        ...prevState,
        [storeId]: { state: 'error', message: e?.message ?? '自動取得に失敗しました' },
      }));
    }
  };

  const handleAutoFetchMode = (storeId: Store['id'], mode: 'all' | 'ingredients') => {
    setSelectedStoreIds((prev) => {
      const next = new Set(prev);
      next.add(storeId);
      return next;
    });

    if (mode === 'all') {
      startAutoFetchForStore(storeId);
    } else {
      startAutoFetchIngredientsForStore(storeId);
    }
  };

  const handleGenerate = async () => {
    setError(null);
    setResult(null);

    if (selectedStores.length === 0) {
      setError('スーパーを1つ以上選んでください。');
      return;
    }
    if (!fridgeText.trim()) {
      setError('冷蔵庫の中身を入力してください。');
      return;
    }
    if (!requestText.trim()) {
      setError('要望を入力してください。');
      return;
    }

    setIsGenerating(true);

    try {
      // ✅ 選択中店舗の自動取得items + 手動アップロードitems をまとめて plan に渡す
      const autoItems = selectedStores.flatMap((s) => {
        const it = autoFlyerByStore[s.id]?.items;
        return Array.isArray(it) ? it : [];
      });

      const uploadItems =
        flyerMode === 'ingredients'
          ? Array.isArray(flyerIngredientResult?.items)
            ? flyerIngredientResult.items
            : []
          : flyerMode === 'all'
            ? Array.isArray(flyerResult?.items)
              ? flyerResult.items
              : []
            : [];

      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stores: selectedStores, // label/url もサーバーへ渡す
          fridgeText,
          requestText,
          flyerItems: [...autoItems, ...uploadItems],
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? `APIエラー（${res.status}）`);
        return;
      }

      const menuDays = data?.menuDays;
      if (!Array.isArray(menuDays)) {
        setError('APIの形式が想定と違います（menuDaysがありません）');
        console.log('Unexpected response from /api/plan:', data);
        return;
      }

      setResult(menuDays as MenuDay[]);
    } catch (e) {
      console.error(e);
      setError('通信に失敗しました。ターミナルのログも確認してください。');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExtractFlyer = async () => {
    setFlyerError(null);
    setFlyerResult(null);

    if (flyerAbortRef.current) flyerAbortRef.current.abort();

    if (!flyerFile) {
      setFlyerError('チラシファイル（PDF/画像）を選択してください。');
      return;
    }

    setFlyerExtracting(true);
    const ac = new AbortController();
    flyerAbortRef.current = ac;

    try {
      const formData = new FormData();
      formData.append('file', flyerFile);

      const res = await fetch('/api/flyer/extract', {
        method: 'POST',
        body: formData,
        signal: ac.signal,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setFlyerError(data?.error ?? `APIエラー（${res.status}）`);
        return;
      }

      if (!data || typeof data !== 'object') {
        setFlyerError('APIの形式が想定と違います（JSONではありません）。');
        console.log('Unexpected response from /api/flyer/extract:', data);
        return;
      }

      setFlyerResult(data as FlyerExtractResponse);
      setFlyerMode('all');
    } catch (e) {
      if ((e as any)?.name === 'AbortError') return;
      setFlyerError('通信に失敗しました。ターミナルのログも確認してください。');
      console.error(e);
    } finally {
      setFlyerExtracting(false);
    }
  };

  const handleExtractFlyerIngredients = async () => {
    setFlyerIngredientError(null);
    setFlyerIngredientResult(null);

    if (flyerIngredientAbortRef.current) flyerIngredientAbortRef.current.abort();

    if (!flyerFile) {
      setFlyerIngredientError('チラシファイル（PDF/画像）を選択してください。');
      return;
    }

    setFlyerIngredientExtracting(true);
    const ac = new AbortController();
    flyerIngredientAbortRef.current = ac;

    try {
      const formData = new FormData();
      formData.append('file', flyerFile);

      const res = await fetch('/api/flyer/extract?mode=ingredients', {
        method: 'POST',
        body: formData,
        signal: ac.signal,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setFlyerIngredientError(data?.error ?? `APIエラー（${res.status}）`);
        return;
      }

      if (!data || typeof data !== 'object') {
        setFlyerIngredientError('APIの形式が想定と違います（JSONではありません）。');
        console.log('Unexpected response from /api/flyer/extract?mode=ingredients:', data);
        return;
      }

      setFlyerIngredientResult(data as FlyerExtractResponse);
      setFlyerMode('ingredients');
    } catch (e) {
      if ((e as any)?.name === 'AbortError') return;
      setFlyerIngredientError('通信に失敗しました。ターミナルのログも確認してください。');
      console.error(e);
    } finally {
      setFlyerIngredientExtracting(false);
    }
  };

  const handleReset = () => {
    setError(null);
    setResult(null);
    setFridgeText('');
    setRequestText('');
    setSelectedStoreIds(new Set());

    // 実行中の自動取得を全部中断
    Object.values(abortRef.current).forEach((c) => c?.abort?.());
    abortRef.current = {};

    // チラシ関連もリセット
    flyerAbortRef.current?.abort();
    flyerIngredientAbortRef.current?.abort();
    setFlyerFile(null);
    setFlyerError(null);
    setFlyerResult(null);
    setFlyerIngredientError(null);
    setFlyerIngredientResult(null);
    setFlyerIngredientExtracting(false);
    setFlyerExtracting(false);
    setFlyerMode(null);

    setAutoFlyerByStore({});
    setAutoStateByStore({
      life_kawasaki_oshima: { state: 'idle' },
      aoba_oshima: { state: 'idle' },
      itoyokado_kawasaki: { state: 'idle' },
    });
    setAutoModeByStore({
      life_kawasaki_oshima: null,
      aoba_oshima: null,
      itoyokado_kawasaki: null,
    });
  };

  const flyerItemsCount = Array.isArray(flyerResult?.items) ? flyerResult!.items!.length : 0;
  const flyerWarnings = Array.isArray(flyerResult?.warnings) ? (flyerResult!.warnings as string[]) : [];
  const flyerIngredientItemsCount = Array.isArray(flyerIngredientResult?.items)
    ? flyerIngredientResult!.items!.length
    : 0;
  const flyerIngredientWarnings = Array.isArray(flyerIngredientResult?.warnings)
    ? (flyerIngredientResult!.warnings as string[])
    : [];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">主婦の味方 献立AI（MVP）</h1>
          <p className="mt-2 text-sm text-zinc-300">
            チラシ（Web/アップロード）＋冷蔵庫の中身＋要望から献立を作る。いまはAPI経由で生成（Gemini）。
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: Inputs */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 shadow-sm">
            <h2 className="text-lg font-medium">入力</h2>

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-zinc-200">スーパー選択（MVP固定）</label>
                <span className="text-xs text-zinc-400">※ 抽出モードを選択して実行</span>
              </div>

              <div className="mt-3 space-y-2">
                {STORES.map((s) => {
                  const checked = selectedStoreIds.has(s.id);
                  const st = autoStateByStore[s.id];
                  const count = getAutoItemsCount(s.id);
                  const mode = autoModeByStore[s.id];
                  const isLoading = st?.state === 'loading';
                  const isDone = st?.state === 'done';
                  const isAllActive = mode === 'all';
                  const isIngredientsActive = mode === 'ingredients';
                  const ingredientNames = (() => {
                    if (!checked || mode !== 'ingredients' || st?.state !== 'done') return [];
                    const it = autoFlyerByStore[s.id]?.items;
                    if (!Array.isArray(it)) return [];
                    return it
                      .map((x) => (typeof (x as any)?.name === 'string' ? String((x as any).name) : ''))
                      .filter((x) => x);
                  })();

                  return (
                    <div
                      key={s.id}
                      className={cx(
                        'rounded-xl border p-3 transition',
                        checked
                          ? 'border-zinc-500 bg-zinc-800/60'
                          : 'border-zinc-800 bg-zinc-950/40 hover:bg-zinc-900/50'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        {/* Left */}
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{s.label}</div>
                          <div className="mt-1 truncate text-xs text-zinc-400">{s.url}</div>

                          {/* 失敗時だけ、簡易メッセージ（入力は止めない） */}
                          {checked && st?.state === 'error' && (
                            <div className="mt-2 text-xs text-red-300">{st.message ?? '自動取得に失敗しました'}</div>
                          )}
                        </div>

                        {/* Right (spinner / status) */}
                        <div className="ml-3 flex shrink-0 flex-col items-end gap-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleAutoFetchMode(s.id, 'all')}
                              disabled={isLoading || isDone}
                              className={cx(
                                'rounded-full border px-3 py-1 text-xs transition',
                                !isLoading && !isDone
                                  ? 'border-zinc-700 bg-zinc-900/60 text-zinc-100 hover:bg-zinc-800'
                                  : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-500'
                              )}
                            >
                              {isAllActive && isLoading ? '抽出中…' : 'チラシ全体'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAutoFetchMode(s.id, 'ingredients')}
                              disabled={isLoading || isDone}
                              className={cx(
                                'rounded-full border px-3 py-1 text-xs transition',
                                !isLoading && !isDone
                                  ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-900/40'
                                  : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-500'
                              )}
                            >
                              {isIngredientsActive && isLoading ? '抽出中…' : '食材だけ'}
                            </button>
                          </div>

                          {checked && st?.state === 'done' && (
                            <span className="rounded-full border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200">
                              {count}件
                            </span>
                          )}

                          {checked && st?.state === 'error' && (
                            <span className="rounded-full border border-red-900/60 bg-red-950/20 px-2 py-1 text-xs text-red-200">
                              !
                            </span>
                          )}
                        </div>
                      </div>

                      {ingredientNames.length > 0 && (
                        <div className="mt-3 rounded-xl border border-emerald-900/40 bg-emerald-950/15 p-3 text-xs text-emerald-100">
                          <div className="font-semibold text-emerald-200">食材</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {ingredientNames.map((name, i) => (
                              <span
                                key={`${name}-${i}`}
                                className="rounded-full border border-emerald-800/60 bg-emerald-950/20 px-2 py-1 text-[11px]"
                              >
                                {name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 text-xs text-zinc-400">
                ※ ローディング中でも、下の「冷蔵庫の中身」「要望」はどんどん書いてOKです（裏で取得します）。
              </div>
            </div>

            <div className="mt-6">
              <label className="text-sm font-medium text-zinc-200">冷蔵庫の中身（複数行）</label>
              <textarea
                className="mt-2 h-28 w-full rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-sm outline-none focus:border-zinc-500"
                placeholder="例: ニンジン2本&#10;大根1本"
                value={fridgeText}
                onChange={(e) => setFridgeText(e.target.value)}
              />
            </div>

            <div className="mt-6">
              <label className="text-sm font-medium text-zinc-200">要望（複数行）</label>
              <textarea
                className="mt-2 h-28 w-full rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-sm outline-none focus:border-zinc-500"
                placeholder="例: 3日分の献立を考えてください&#10;普通の主婦にもできるメニューにしてください"
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
              />
            </div>

            {/* Manual Flyer Upload (既存) */}
            <div className="mt-6">
              <label className="text-sm font-medium text-zinc-200">チラシ（PDF/画像：手動アップロード）</label>
              <input
                type="file"
                accept="application/pdf,image/*"
                className="mt-2 block w-full text-sm text-zinc-200 file:mr-3 file:rounded-lg file:border file:border-zinc-700 file:bg-zinc-900 file:px-3 file:py-2 file:text-zinc-200 hover:file:bg-zinc-800"
                onChange={(e) => setFlyerFile(e.target.files?.[0] ?? null)}
              />

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleExtractFlyer}
                  disabled={!flyerFile || flyerExtracting}
                  className={cx(
                    'rounded-xl px-4 py-2 text-sm font-medium transition',
                    flyerFile && !flyerExtracting
                      ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
                      : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                  )}
                >
                  {flyerExtracting ? '抽出中…' : 'チラシを抽出（β）'}
                </button>

                <button
                  type="button"
                  onClick={handleExtractFlyerIngredients}
                  disabled={!flyerFile || flyerIngredientExtracting}
                  className={cx(
                    'rounded-xl px-4 py-2 text-sm font-medium transition',
                    flyerFile && !flyerIngredientExtracting
                      ? 'bg-emerald-200 text-emerald-950 hover:bg-emerald-100'
                      : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                  )}
                >
                  {flyerIngredientExtracting ? '抽出中…' : '食材だけ抽出（β）'}
                </button>

                {flyerFile && (
                  <span className="text-xs text-zinc-400">
                    {flyerFile.name}（{Math.round(flyerFile.size / 1024)} KB）
                  </span>
                )}
              </div>

              {flyerResult && (
                <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">チラシ抽出結果（手動アップロード）</div>
                    <div className="text-xs text-zinc-400">Gemini Vision</div>
                  </div>

                  <div className="mt-2 text-xs text-zinc-400">items: {flyerItemsCount} 件</div>

                  {flyerWarnings.length > 0 && (
                    <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
                      <div className="font-semibold">warnings</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {flyerWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-200">
                    {JSON.stringify(flyerResult, null, 2)}
                  </pre>
                </div>
              )}

              {flyerError && (
                <div className="mt-3 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
                  {flyerError}
                </div>
              )}

              {flyerIngredientResult && (
                <div className="mt-6 rounded-2xl border border-emerald-900/40 bg-emerald-950/20 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">食材だけ抽出結果（手動アップロード）</div>
                    <div className="text-xs text-emerald-200">Gemini Vision</div>
                  </div>

                  <div className="mt-2 text-xs text-emerald-200">items: {flyerIngredientItemsCount} 件</div>

                  {flyerIngredientWarnings.length > 0 && (
                    <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
                      <div className="font-semibold">warnings</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {flyerIngredientWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-3 text-xs text-emerald-100">
                    {JSON.stringify(flyerIngredientResult, null, 2)}
                  </pre>
                </div>
              )}

              {flyerIngredientError && (
                <div className="mt-3 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
                  {flyerIngredientError}
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate}
                className={cx(
                  'rounded-xl px-4 py-2 text-sm font-medium transition',
                  canGenerate ? 'bg-zinc-100 text-zinc-900 hover:bg-white' : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                )}
              >
                {isGenerating ? '生成中…' : '献立を作る'}
              </button>

              <button
                type="button"
                onClick={handleReset}
                className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900/40"
              >
                リセット
              </button>
            </div>

            <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-300">
              いまは <span className="text-zinc-100">/api/plan</span> 経由で Gemini を呼び出します（APIキーはサーバー側だけ）。
            </div>
          </section>

          {/* Right: Output */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">出力</h2>
              <span className="text-xs text-zinc-400">MVP</span>
            </div>

            {!result ? (
              <div className="mt-6 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/20 p-6">
                <div className="text-sm text-zinc-300">まだ結果はありません。</div>
                <div className="mt-2 text-xs text-zinc-400">左で入力して「献立を作る」を押すと表示されます。</div>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {result.map((d) => (
                  <div key={d.dayLabel} className="rounded-2xl border border-zinc-800 bg-zinc-950/30 p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-sm font-semibold">{d.dayLabel}</div>
                      <div className="text-xs text-zinc-400">MVP</div>
                    </div>

                    <div className="mt-2 text-base font-medium">{d.title}</div>

                    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-200">
                      {d.points.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>

                    <div className="mt-4">
                      <div className="text-xs font-medium text-zinc-300">買い足し候補</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {d.suggestedIngredients.map((x) => (
                          <span
                            key={x}
                            className="rounded-full border border-zinc-700 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-200"
                          >
                            {x}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
                  次は「チラシ取得（Webのresolve対応）→ Gemini 解析 → 献立精度アップ」に繋げます。
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="mt-10 text-xs text-zinc-500">
          Dev server を止める: ターミナルで <span className="text-zinc-300">Ctrl + C</span>
        </footer>
      </div>
    </main>
  );
}
