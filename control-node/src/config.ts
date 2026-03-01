import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),

  regiondo: {
    publicKey: requireEnv("REGIONDO_PUBLIC_KEY"),
    privateKey: requireEnv("REGIONDO_PRIVATE_KEY"),
    baseUrl: process.env.REGIONDO_BASE_URL ?? "https://api.regiondo.com/v1/",
    language: process.env.REGIONDO_LANGUAGE ?? "de-DE",
  },

  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? "5", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;
