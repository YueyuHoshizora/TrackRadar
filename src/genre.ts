import type { Env } from "./types";
import genreCriteria from "./genres.json";

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevResponse {
  model: string;
  answers: {
    genre?: JevChoiceAnswer;
  };
}

// @cloudflare/workers-types 尚未收錄第三方模型 typesafe/jev 的型別，這裡自行定義輸入/輸出並用最小必要的
// unknown 轉型呼叫 env.AI.run，避免影響其餘已知模型呼叫的型別檢查。
type AiRun = (model: "typesafe/jev", inputs: unknown) => Promise<JevResponse>;

export interface GenreResult {
  genre: string;
  confidence: number;
}

/**
 * 用 Cloudflare Workers AI 的 typesafe/jev 模型，根據影片標題與頻道名稱判斷曲風分類。
 * 分類選項與判斷依據定義在 src/genres.json；分類失敗（模型錯誤/未設定 binding）時回傳 null，不中斷主流程。
 */
export async function classifyGenre(env: Env, title: string, channelTitle: string): Promise<GenreResult | null> {
  if (!env.AI) return null;
  try {
    const run = (env.AI as unknown as { run: AiRun }).run.bind(env.AI);
    const response = await run("typesafe/jev", {
      state: { title, channelTitle },
      questions: {
        genre: {
          type: "choice",
          instructions: "根據 YouTube 影片標題與頻道名稱，判斷這支影片最符合下列哪一種音樂曲風分類。",
          criteria: genreCriteria,
        },
      },
    });
    const answer = response?.answers?.genre;
    if (!answer || answer.type !== "choice" || !answer.choice) return null;
    return { genre: answer.choice, confidence: answer.confidence };
  } catch (err) {
    console.error("TrackRadar: genre classification failed", err);
    return null;
  }
}
