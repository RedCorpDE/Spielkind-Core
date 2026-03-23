import { appConfig } from '../config.js';
import { signRegiondoRequest } from './auth.js';

type RegiondoCollectionResponse<T> = {
  data?: T[];
  items?: T[];
};

export class RegiondoClient {
  private readonly baseUrl = new URL(appConfig.REGIONDO_BASE_URL.endsWith('/') ? appConfig.REGIONDO_BASE_URL : `${appConfig.REGIONDO_BASE_URL}/`);

  async getCollection<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const timestamp = Math.floor(Date.now() / 1000);
    const queryParams = new URLSearchParams(params);
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    url.search = queryParams.toString();

    const hash = signRegiondoRequest({
      timestamp,
      publicKey: appConfig.REGIONDO_PUBLIC_KEY,
      privateKey: appConfig.REGIONDO_PRIVATE_KEY,
      queryParams
    });

    const response = await fetch(url, {
      headers: {
        'X-API-ID': appConfig.REGIONDO_PUBLIC_KEY,
        'X-API-TIME': `${timestamp}`,
        'X-API-HASH': hash,
        'Accept-Language': appConfig.REGIONDO_LANGUAGE,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Regiondo request failed ${response.status}: ${text}`);
    }

    const body = (await response.json()) as RegiondoCollectionResponse<T>;
    return body.data ?? body.items ?? [];
  }
}

export const regiondoClient = new RegiondoClient();
