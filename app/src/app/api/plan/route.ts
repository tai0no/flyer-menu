// src/app/api/plan/route.ts

import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  buildPlanPrompt,
  inferConstraintsFromRequest,
  parsePlanFromModelText,
  type PlanRequestBody,
} from '@/app/lib/plan';

export const runtime = 'nodejs';

function envOrThrow(key: string) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<PlanRequestBody>;

    const stores = Array.isArray(body.stores) ? body.stores : [];
    const fridgeText = typeof body.fridgeText === 'string' ? body.fridgeText : '';
    const requestText = typeof body.requestText === 'string' ? body.requestText : '';
    const flyerItems = Array.isArray(body.flyerItems) ? body.flyerItems : undefined;

    if (stores.length === 0) {
      return NextResponse.json({ error: 'スーパーを1つ以上選んでください。' }, { status: 400 });
    }
    if (!fridgeText.trim()) {
      return NextResponse.json({ error: '冷蔵庫の中身を入力してください。' }, { status: 400 });
    }
    if (!requestText.trim()) {
      return NextResponse.json({ error: '要望を入力してください。' }, { status: 400 });
    }

    const apiKey = envOrThrow('GEMINI_API_KEY');
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 65536);
    const temperature = Number(process.env.GEMINI_TEMPERATURE || 0.7);

    const inferred = inferConstraintsFromRequest(requestText);

    const prompt = buildPlanPrompt({
      stores,
      fridgeText,
      requestText,
      flyerItems,
      days: inferred.days,
      difficulty: inferred.difficulty,
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
      },
    });

    const text = result.response.text();

    // strict: 日数は inferred.days と一致させる（ズレたら弾く）
    const parsed = parsePlanFromModelText(text, inferred.days);

    // metaに推定理由を入れて返す（UIで出してもいいし、隠してもOK）
    parsed.meta.derivedFromRequest = inferred.derivedFromRequest;
    parsed.meta.reason = inferred.reason;

    return NextResponse.json(parsed);
  } catch (e: any) {
    console.error(e);

    // 例: JSON parse エラーや Gemini エラー
    const message = typeof e?.message === 'string' ? e.message : 'unknown error';

    return NextResponse.json(
      {
        error: '献立生成に失敗しました。',
        detail: message,
      },
      { status: 500 }
    );
  }
}
