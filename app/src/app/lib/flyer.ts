// src/app/lib/flyer.ts

export type FlyerItem = {
  category: string; // 例: 精肉 / 鮮魚 / 青果 / 惣菜 / 日配 / 冷凍 / 菓子 / 飲料 / 調味料 / 米・麺 / その他
  name: string;     // できるだけ具体名（ブランド/規格/産地/容量）
  priceYen: number; // 数字のみ
  unit?: string;    // 例: 100g / 1パック / 1本 / 1尾
  notes?: string;   // 税抜/税込、〇点で、会員価格、期間など
};

export type FlyerExtractResponse = {
  items: FlyerItem[];
  count: number;
  meta: Record<string, unknown>;
  warnings: string[];
};

export function buildFlyerExtractPrompt(args: { tileIndex: number; tileCount: number }) {
  const { tileIndex, tileCount } = args;

  return `
あなたは「スーパーチラシ」から価格付き商品を漏れなく抽出するエンジンです。
これはチラシ全体のうちのタイル ${tileIndex}/${tileCount} です。このタイル内に見える商品だけを抽出してください。

【目的】
- このタイルに掲載されている「価格（円）が明記された商品」を可能な限り漏れなく列挙する。

【抽出ルール】
- 対象: 価格（円）が書かれている商品。セット価格（例: 2点で◯円）、会員価格、クーポン価格、○%OFF 等も含める。
- 1つの枠に複数商品がある場合は全て列挙する。
- 商品名はできるだけ具体的に：ブランド/部位/産地/規格/内容量（100g, 1パック等）を name / unit / notes に反映する。短縮しない。
- priceYen は「数字のみ」。税抜/税込/条件は notes に書く。
- category はチラシ上の見出しに合わせて推定。迷う場合は "その他"。
- チラシに無い商品を創作しない。読めない場合は name に「判読不能」を含め、notes に理由を書く。
- 重複は避ける（同一商品・同一価格・同一規格は1つにまとめる）。ただし別規格/別価格は別アイテム。

【出力】
- 次のJSON“だけ”を返す（説明文やmarkdown禁止）:
{
  "items": FlyerItem[]
}
`.trim();
}

export function buildFlyerIngredientExtractPrompt(args: { tileIndex: number; tileCount: number }) {
  const { tileIndex, tileCount } = args;

  return `
あなたは「スーパーチラシ」から食材だけを抽出するエンジンです。
これはチラシ全体のうちのタイル ${tileIndex}/${tileCount} です。このタイル内に見える商品だけを抽出してください。

【目的】
- このタイルに掲載されている「食材（料理に使う生鮮・素材）」を可能な限り漏れなく列挙する。

【除外】
- 惣菜（弁当、総菜、揚げ物、出来合い、寿司、サラダ惣菜）
- 調味料（醤油、みそ、砂糖、塩、だし、酢、ソース類、ドレッシング、油）
- 菓子、飲料、酒、日用品

【抽出ルール】
- 対象: 価格（円）が書かれている食材。セット価格、会員価格、クーポン価格、○%OFF 等も含める。
- 対象カテゴリの目安: 精肉 / 鮮魚 / 青果 / 卵 / 乳製品 / 豆腐・豆類 / 米・麺
- 迷う場合は notes に「要確認」を付け、category は推定でOK。
- 商品名はできるだけ具体的に：ブランド/部位/産地/規格/内容量（100g, 1パック等）を name / unit / notes に反映する。短縮しない。
- priceYen は「数字のみ」。税抜/税込/条件は notes に書く。
- チラシに無い商品を創作しない。読めない場合は name に「判読不能」を含め、notes に理由を書く。
- 重複は避ける（同一商品・同一価格・同一規格は1つにまとめる）。ただし別規格/別価格は別アイテム。
- 同一タイル内で多すぎる場合は、より大きく表示されている商品を優先して列挙する。

【出力】
- 次のJSON“だけ”を返す（説明文やmarkdown禁止）:
{
  "items": FlyerItem[]
}
`.trim();
}

export function safeParseJsonFromModel(text: string): any {
  // ```json ... ``` 対策 + 余計な前置き対策
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`JSONが見つかりませんでした: ${text.slice(0, 200)}`);
  }
  const jsonText = candidate.slice(start, end + 1);
  return JSON.parse(jsonText);
}

export function normalizeFlyerItem(raw: any): FlyerItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'その他';

  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : undefined;
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : undefined;

  const priceYen = toNumberPrice(raw.priceYen ?? raw.price ?? raw.price_yen);
  if (!Number.isFinite(priceYen) || priceYen <= 0) {
    // 値段が読めないものは混入しやすいので落とす（必要ならここは緩める）
    return null;
  }

  return { category, name, priceYen, unit, notes };
}

function toNumberPrice(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = v.replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

export function makeDedupKey(it: FlyerItem): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[（）()\[\]【】「」『』・,，.．。:：/／]/g, '');

  return `${norm(it.name)}|${it.priceYen}|${norm(it.unit ?? '')}`;
}
