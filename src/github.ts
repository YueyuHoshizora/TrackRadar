import type { Env } from "./types";

const API_BASE = "https://api.github.com";

function apiUrl(env: Env, path: string): string {
  return `${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
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

/** 建立或更新檔案 */
export async function putFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: toBase64(content),
    branch: env.GITHUB_BRANCH,
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
}

/** 建立或更新 JSON 檔案（自動取得目前 sha） */
export async function putJson(env: Env, path: string, data: unknown, message: string): Promise<void> {
  const existing = await getFile(env, path);
  const content = JSON.stringify(data, null, 2) + "\n";
  await putFile(env, path, content, message, existing?.sha);
}
