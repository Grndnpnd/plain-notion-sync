import { Redis } from "ioredis";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";

const KEY = "plain_notion_sync:last_run";
const FILE_FALLBACK = ".last_run"; // used when REDIS_URL is unset (local dev)

export async function getLastSyncedAt(): Promise<string | null> {
  if (config.redisUrl) {
    const redis = new Redis(config.redisUrl);
    try {
      return await redis.get(KEY);
    } finally {
      redis.disconnect();
    }
  }
  try {
    return (await readFile(FILE_FALLBACK, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function setLastSyncedAt(iso: string): Promise<void> {
  if (config.redisUrl) {
    const redis = new Redis(config.redisUrl);
    try {
      await redis.set(KEY, iso);
    } finally {
      redis.disconnect();
    }
    return;
  }
  await writeFile(FILE_FALLBACK, iso, "utf8");
}
