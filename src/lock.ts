import { DurableObject } from "cloudflare:workers";

/** 單次執行最長持有時間；Worker 當機沒釋放時，逾時後自動失效（cron 最長 wall time 為 15 分鐘）。 */
const LOCK_TTL_MS = 15 * 60 * 1000;
/** 手動 /run 兩次開始之間至少間隔多久，限制權杖外洩時的濫用頻率。 */
export const MANUAL_RUN_COOLDOWN_MS = 60 * 1000;

interface LockState {
  owner: string;
  expiresAt: number;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: "running" }
  | { ok: false; reason: "cooldown"; retryAfterSeconds: number };

/**
 * 全域唯一的執行鎖：cron 與手動 /run 共用，確保同時只有一輪 runOnce 在寫 GitHub。
 * Durable Object 單執行緒且有 input gate，get→put 之間不會插入其他請求，因此取鎖是原子的。
 */
export class RunLock extends DurableObject {
  async acquire(owner: string, cooldownMs: number): Promise<AcquireResult> {
    const now = Date.now();
    const lock = await this.ctx.storage.get<LockState>("lock");
    if (lock && lock.expiresAt > now) return { ok: false, reason: "running" };
    const lastStartedAt = (await this.ctx.storage.get<number>("lastStartedAt")) ?? 0;
    const wait = lastStartedAt + cooldownMs - now;
    if (wait > 0) return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil(wait / 1000) };
    await this.ctx.storage.put({ lock: { owner, expiresAt: now + LOCK_TTL_MS }, lastStartedAt: now });
    return { ok: true };
  }

  async release(owner: string): Promise<void> {
    const lock = await this.ctx.storage.get<LockState>("lock");
    if (lock?.owner === owner) await this.ctx.storage.delete("lock");
  }
}
