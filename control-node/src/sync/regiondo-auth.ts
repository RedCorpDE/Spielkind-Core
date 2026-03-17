import crypto from "crypto";
import { config } from "../config.js";

export interface RegionalHeaders {
  "X-API-ID": string;
  "X-API-TIME": string;
  "X-API-HASH": string;
  "Accept-Language": string;
  Accept: string;
}

export function buildRegionalHeaders(
  queryParams: Record<string, string> = {}
): RegionalHeaders {
  const time = Math.floor(Date.now()).toString();
  const { publicKey, privateKey, language } = config.regiondo;

  const queryString = new URLSearchParams(queryParams).toString();
  const message = time + publicKey + queryString;
  const hash = crypto
    .createHmac("sha256", privateKey)
    .update(message)
    .digest("hex");

  return {
    "X-API-ID": publicKey,
    "X-API-TIME": time,
    "X-API-HASH": hash,
    "Accept-Language": language,
    Accept: "application/json",
  };
}
