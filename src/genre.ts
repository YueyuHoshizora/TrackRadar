import type { Env } from "./types";
import genreCriteria from "./genres.json";

const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface DecisionsResponse {
  answers: {
    genre?: JevChoiceAnswer;
  };
}

export interface GenreResult {
  genre: string;
  confidence: number;
}

/**
 * 透過 OpenRouter 的 Decisions API 呼叫 typesafe/jev 模型，根據影片標題與頻道名稱判斷曲風分類。
 * 分類選項與判斷依據定義在 src/genres.json；分類失敗（未設定 OPENROUTER_API_KEY/模型錯誤）時回傳 null，不中斷主流程。
 */
export async function classifyGenre(env: Env, title: string, channelTitle: string): Promise<GenreResult | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const res = await fetch(DECISIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        state: { title, channelTitle },
        questions: {
          genre: {
            type: "choice",
            instructions: "根據 YouTube 影片標題與頻道名稱，判斷這支影片最符合下列哪一種音樂曲風分類。",
            criteria: genreCriteria,
          },
        },
      }),
    });
    if (!res.ok) {
      console.error(`TrackRadar: OpenRouter decisions request failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as DecisionsResponse;
    const answer = data?.answers?.genre;
    if (!answer || answer.type !== "choice" || !answer.choice) return null;
    return { genre: answer.choice, confidence: answer.confidence };
  } catch (err) {
    console.error("TrackRadar: genre classification failed", err);
    return null;
  }
}
