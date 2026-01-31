// src/app/lib/plan.ts

export type Difficulty = 'easy' | 'normal' | 'hard';

export type StoreInput = {
  id: string;
  label: string;
  url: string;
};

export type FlyerItem = {
  category?: string;
  name: string;
  priceYen?: number;
  unit?: string;
  notes?: string;
};

export type MenuDay = {
  dayLabel: string; // "1日目" など
  meals: Array<{
    mealLabel: string; // 朝食/昼食/夕食
    title: string;
    summary: string;
    ingredients: string[];
    steps: string[];
  }>;
  suggestedIngredients: string[];
};

export type PlanMeta = {
  days: number; // 1..7
  difficulty: Difficulty;
  derivedFromRequest: boolean; // 要望から推定したか
  reason?: string; // どう推定したか（デバッグ用）
};

export type PlanResponse = {
  meta: PlanMeta;
  menuDays: MenuDay[];
};

export type PlanRequestBody = {
  stores: StoreInput[];
  fridgeText: string;
  requestText: string;
  flyerItems?: FlyerItem[]; // まだ未接続なら省略でOK
  days?: number; // 1..7
  people?: number; // 1..5
};

function toHalfWidthDigits(s: string) {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function normalizeText(s: string) {
  return toHalfWidthDigits(s).trim();
}

function kanjiNumberToInt(kanji: string): number | null {
  // 対応範囲: 1..14 を想定（最終的な上限は 7 に丸める）
  const table: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12,
    十三: 13,
    十四: 14,
  };
  return table[kanji] ?? null;
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function inferConstraintsFromRequest(requestText: string): {
  days: number;
  difficulty: Difficulty;
  derivedFromRequest: boolean;
  reason: string;
} {
  const raw = normalizeText(requestText);
  const lower = raw.toLowerCase();

  // ---- days ----
  let days: number | null = null;
  let reasonDays = '';

  // 例: "3日分", "7日", "14日間"
  {
    const m = raw.match(/(\d+)\s*(日|日分|日間)/);
    if (m) {
      days = clampInt(parseInt(m[1], 10), 1, 7);
      reasonDays = `digits:${m[0]}`;
    }
  }

  // 例: "一週間", "2週間"
  if (days == null) {
    const m = raw.match(/(\d+)\s*週間/);
    if (m) {
      const w = parseInt(m[1], 10);
      days = clampInt(w * 7, 1, 7);
      reasonDays = `weeks:${m[0]}`;
    } else if (raw.includes('一週間')) {
      days = 7;
      reasonDays = 'weeks:一週間';
    }
  }

  // 例: "三日分", "十日間"
  if (days == null) {
    const m = raw.match(/(一|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四)\s*(日|日分|日間)/);
    if (m) {
      const n = kanjiNumberToInt(m[1]);
      if (n != null) {
        days = clampInt(n, 1, 7);
        reasonDays = `kanji:${m[0]}`;
      }
    }
  }

  // default
  if (days == null) {
    days = 1;
    reasonDays = 'default:1';
  }

  // ---- difficulty ----
  let difficulty: Difficulty = 'normal';
  let reasonDiff = 'default:normal';

  const easyHints = [
    '簡単',
    '時短',
    '手軽',
    '初心者',
    'ラク',
    '短時間',
    'レンチン',
    'ワンパン',
    'フライパン1つ',
    '10分',
    '15分',
    '20分',
    '30分',
    '少ない材料',
    '少なめの工程',
  ];
  const hardHints = ['本格', '手の込んだ', '凝った', '上級', '難しめ', 'じっくり', '手作り'];

  if (easyHints.some((k) => raw.includes(k))) {
    difficulty = 'easy';
    reasonDiff = 'matched:easyHints';
  } else if (hardHints.some((k) => raw.includes(k))) {
    difficulty = 'hard';
    reasonDiff = 'matched:hardHints';
  } else if (raw.includes('中級') || raw.includes('普通') || raw.includes('いつも通り')) {
    difficulty = 'normal';
    reasonDiff = 'matched:normalHints';
  }

  const derivedFromRequest = !(reasonDays.startsWith('default') && reasonDiff.startsWith('default'));

  return {
    days,
    difficulty,
    derivedFromRequest,
    reason: `days=${reasonDays}, difficulty=${reasonDiff}`,
  };
}

function compactFlyerItems(items: FlyerItem[], limit = 220): string {
  // 献立に不要なノイズ(洗剤・日用品など)を“軽く”落とす（完全ではないけど実用的）
  const denyWords = ['ティシュー', '洗剤', 'ハンドソープ', '年賀', 'はがき', '花', 'トイレット', 'アタック', 'アクロン', 'キレイキレイ'];
  const filtered = items.filter((x) => !denyWords.some((w) => (x.name ?? '').includes(w)));

  const sliced = filtered.slice(0, limit);
  return sliced
    .map((x) => {
      const p = x.priceYen != null ? `${x.priceYen}円` : '';
      const u = x.unit ? `/${x.unit}` : '';
      const c = x.category ? `[${x.category}] ` : '';
      return `${c}${x.name}${p ? ` (${p}${u})` : ''}`;
    })
    .join('\n');
}

export function buildPlanPrompt(args: {
  stores: StoreInput[];
  fridgeText: string;
  requestText: string;
  flyerItems?: FlyerItem[];
  days: number;
  people: number;
  difficulty: Difficulty;
}): string {
  const { stores, fridgeText, requestText, flyerItems, days, people, difficulty } = args;

  const storeBlock = stores.map((s) => `- ${s.label} (${s.url})`).join('\n');
  const fridgeLines = normalizeText(fridgeText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 60);

  const reqLines = normalizeText(requestText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 60);

  const flyerBlock = flyerItems && flyerItems.length > 0 ? compactFlyerItems(flyerItems) : '';

  return `
あなたは日本の家庭料理に詳しい献立作成AIです。
以下の入力から、指定された日数ぶんの献立を作ってください。

# 重要制約（必ず守る）
- 出力は **必ず** JSONのみ（Markdown禁止、コードフェンス禁止）。
- menuDays は **必ず ${days} 件**。
- 難易度 difficulty は "${difficulty}"。
- 1日あたり：朝食/昼食/夕食の3つ。家庭向け。
- summary は1行の短文（30字程度）でコツや特徴を書く。
- ingredients はその献立で使う食材と分量のセット（例: "豆腐(1/2パック)"）。最大8個まで。
- steps は箇条書きの短文。最大6個まで。
- 材料の分量（容量/重さ/個数）を必ず考慮し、必要量の目安を steps に含める。
- suggestedIngredients は「買い足し候補」。最大12個まで。

# 難易度の解釈
- easy: 時短・少工程・市販調味料OK・洗い物少なめ
- normal: ふつうの家庭料理
- hard: 手作り工程あり・一手間多め・ただし現実的

# 入力
## 対象スーパー
${storeBlock}

## 冷蔵庫の中身（ユーザー入力）
${fridgeLines.map((x) => `- ${x}`).join('\n')}

## 人数
${people}人

## 要望（ユーザー入力）
${reqLines.map((x) => `- ${x}`).join('\n')}

${flyerBlock ? `## チラシ（購入候補リスト）
${flyerBlock}` : ''}

# 出力JSONスキーマ
{
  "meta": {
    "days": number,
    "difficulty": "easy" | "normal" | "hard",
    "derivedFromRequest": boolean,
    "reason": string
  },
  "menuDays": [
    {
      "dayLabel": string,
      "meals": [
        {
          "mealLabel": "朝食" | "昼食" | "夕食",
          "title": string,
          "summary": string,
          "ingredients": string[],
          "steps": string[]
        }
      ],
      "suggestedIngredients": string[]
    }
  ]
}

注意:
- dayLabel は "1日目" から連番。
- 冷蔵庫の食材を優先して使い、足りないものを suggestedIngredients に入れる。
- チラシがある場合、suggestedIngredients はチラシ由来を優先する。
- meals は必ず "朝食", "昼食", "夕食" の順で出す。
`.trim();
}

export function extractJsonObject(text: string): unknown {
  // Geminiが前後に説明文を混ぜた時に備えて、最初の { から最後の } を抜く
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model output');
  }
  const sliced = text.slice(start, end + 1);
  return JSON.parse(sliced);
}

function isDifficulty(x: unknown): x is Difficulty {
  return x === 'easy' || x === 'normal' || x === 'hard';
}

function assertStringArray(x: unknown, field: string) {
  if (!Array.isArray(x) || !x.every((v) => typeof v === 'string')) {
    throw new Error(`Invalid ${field}: expected string[]`);
  }
}

export function validatePlanResponse(obj: unknown, expectedDays?: number): PlanResponse {
  if (typeof obj !== 'object' || obj == null) throw new Error('Response is not an object');

  const o = obj as any;
  if (typeof o.meta !== 'object' || o.meta == null) throw new Error('meta is missing');
  if (!Number.isInteger(o.meta.days)) throw new Error('meta.days must be integer');
  if (!isDifficulty(o.meta.difficulty)) throw new Error('meta.difficulty invalid');

  const days = clampInt(o.meta.days, 1, 7);

  if (!Array.isArray(o.menuDays)) throw new Error('menuDays must be array');

  if (expectedDays != null && o.menuDays.length !== expectedDays) {
    throw new Error(`menuDays length mismatch: expected ${expectedDays}, got ${o.menuDays.length}`);
  }
  if (o.menuDays.length !== days) {
    throw new Error(`menuDays length mismatch vs meta.days: meta.days=${days}, got ${o.menuDays.length}`);
  }

  const menuDays: MenuDay[] = o.menuDays.map((d: any, idx: number) => {
    if (typeof d !== 'object' || d == null) throw new Error(`menuDays[${idx}] is not object`);
    if (typeof d.dayLabel !== 'string') throw new Error(`menuDays[${idx}].dayLabel missing`);
    if (!Array.isArray(d.meals)) throw new Error(`menuDays[${idx}].meals must be array`);
    if (d.meals.length !== 3) throw new Error(`menuDays[${idx}].meals must have 3 items`);
    const meals = d.meals.map((m: any, midx: number) => {
      if (typeof m !== 'object' || m == null) throw new Error(`menuDays[${idx}].meals[${midx}] is not object`);
      if (typeof m.mealLabel !== 'string') {
        throw new Error(`menuDays[${idx}].meals[${midx}].mealLabel missing`);
      }
      if (typeof m.title !== 'string') throw new Error(`menuDays[${idx}].meals[${midx}].title missing`);
      if (typeof m.summary !== 'string') throw new Error(`menuDays[${idx}].meals[${midx}].summary missing`);
      assertStringArray(m.ingredients, `menuDays[${idx}].meals[${midx}].ingredients`);
      assertStringArray(m.steps, `menuDays[${idx}].meals[${midx}].steps`);
      return {
        mealLabel: m.mealLabel,
        title: m.title,
        summary: m.summary,
        ingredients: m.ingredients.slice(0, 8),
        steps: m.steps.slice(0, 6),
      };
    });
    assertStringArray(d.suggestedIngredients, `menuDays[${idx}].suggestedIngredients`);
    return {
      dayLabel: d.dayLabel,
      meals,
      suggestedIngredients: d.suggestedIngredients.slice(0, 12),
    };
  });

  const meta: PlanMeta = {
    days,
    difficulty: o.meta.difficulty,
    derivedFromRequest: Boolean(o.meta.derivedFromRequest),
    reason: typeof o.meta.reason === 'string' ? o.meta.reason : undefined,
  };

  return { meta, menuDays };
}

export function parsePlanFromModelText(text: string, expectedDays?: number): PlanResponse {
  const obj = extractJsonObject(text);
  return validatePlanResponse(obj, expectedDays);
}
