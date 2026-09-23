import type { Env } from "./types";
import { toUtc8Iso } from "./time";

const API_BASE = "https://api.github.com";

function repoApiUrl(env: Env, path: string): string {
  return `${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${path}`;
}

function apiUrl(env: Env, path: string): string {
  return repoApiUrl(env, `contents/${path}`);
}

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "TrackRadar-Worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 讀取 repo 內的檔案文字內容；不存在回傳 null */
export async function getFile(
  env: Env,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`${apiUrl(env, path)}?ref=${env.GITHUB_BRANCH}`, {
    headers: headers(env),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub getFile(${path}) failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { content: string; sha: string };
  return { content: fromBase64(json.content), sha: json.sha };
}

/** 讀取 JSON 檔案，不存在回傳 null */
export async function getJson<T>(env: Env, path: string): Promise<T | null> {
  const file = await getFile(env, path);
  if (!file) return null;
  return JSON.parse(file.content) as T;
}

/**
 * 同一輪內多個頻道 worker 平行寫入時，每次 Contents API PUT 都是一個新 commit，
 * 同時送出會讓 GitHub 以 409（branch 已前進）拒絕其中一個，因此所有寫入依序排隊。
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** 建立或更新檔案，回傳新 commit SHA */
export function putFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<string> {
  return serializeWrite(() => putFileNow(env, path, content, message, sha));
}

async function putFileNow(
  env: Env,
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    content: toBase64(content),
    branch: env.GITHUB_BRANCH,
    committer: {
      name: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
    },
  };
  if (sha) body.sha = sha;

  const res = await fetch(apiUrl(env, path), {
    method: "PUT",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub putFile(${path}) failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { commit?: { sha?: string } };
  const commitSha = json.commit?.sha;
  if (!commitSha) {
    throw new Error(`GitHub putFile(${path}) response missing commit SHA`);
  }
  return commitSha;
}

/** 建立或更新 JSON 檔案（自動取得目前 sha），回傳新 commit SHA；讀 sha 與寫入在同一個排隊區段內 */
export function putJson(env: Env, path: string, data: unknown, message: string): Promise<string> {
  return serializeWrite(async () => {
    const existing = await getFile(env, path);
    const content = JSON.stringify(data, null, 2) + "\n";
    return putFileNow(env, path, content, message, existing?.sha);
  });
}

/** 在指定 commit 建立 annotated tag，內容列出本輪修改的頻道 ID。 */
export async function createUpdateTag(
  env: Env,
  tag: string,
  commitSha: string,
  channelIds: string[]
): Promise<void> {
  const message = `TrackRadar JSON update\n\nChanged channels:\n${channelIds.map((id) => `- ${id}`).join("\n")}`;
  const tagRes = await fetch(repoApiUrl(env, "git/tags"), {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      tag,
      message,
      object: commitSha,
      type: "commit",
      tagger: {
        name: "github-actions[bot]",
        email: "41898282+github-actions[bot]@users.noreply.github.com",
        date: toUtc8Iso(new Date()),
      },
    }),
  });
  if (!tagRes.ok) {
    throw new Error(`GitHub createUpdateTag(${tag}) failed: ${tagRes.status} ${await tagRes.text()}`);
  }
  const json = (await tagRes.json()) as { sha?: string };
  if (!json.sha) {
    throw new Error(`GitHub createUpdateTag(${tag}) response missing tag SHA`);
  }

  const refRes = await fetch(repoApiUrl(env, "git/refs"), {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: json.sha }),
  });
  if (!refRes.ok) {
    throw new Error(`GitHub createUpdateTag(${tag}) ref failed: ${refRes.status} ${await refRes.text()}`);
  }
}

/** 取得目前分支 HEAD commit，供 release 固定快照而不受後續排程寫入影響。 */
export async function getBranchHeadSha(env: Env): Promise<string> {
  const res = await fetch(repoApiUrl(env, `git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`), {
    headers: headers(env),
  });
  if (!res.ok) {
    throw new Error(`GitHub get branch HEAD failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { object?: { sha?: string } };
  const sha = json.object?.sha;
  if (!sha) throw new Error("GitHub get branch HEAD response missing commit SHA");
  return sha;
}

/**
 * 建立前一日資料快照的 GitHub Release。Release 的自動 source archive 會固定保存
 * 午夜抓取完成後的完整 repository 資料；同名 release 已存在時安全略過。
 */
export async function createDailyRelease(env: Env, tag: string, commitSha: string): Promise<boolean> {
  const releaseByTagUrl = repoApiUrl(env, `releases/tags/${encodeURIComponent(tag)}`);
  const existingRes = await fetch(releaseByTagUrl, { headers: headers(env) });
  if (existingRes.ok) return false;
  if (existingRes.status !== 404) {
    throw new Error(`GitHub get release(${tag}) failed: ${existingRes.status} ${await existingRes.text()}`);
  }

  const releaseRes = await fetch(repoApiUrl(env, "releases"), {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: commitSha,
      name: tag,
      body: `TrackRadar data snapshot for ${tag.slice(1)} (UTC+8).`,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  });
  if (releaseRes.ok) return true;

  // 排程重試或併發執行可能同時通過上方 404；確認另一個執行已成功建立即可。
  if (releaseRes.status === 422) {
    const racedRes = await fetch(releaseByTagUrl, { headers: headers(env) });
    if (racedRes.ok) return false;
  }
  throw new Error(`GitHub create release(${tag}) failed: ${releaseRes.status} ${await releaseRes.text()}`);
}
