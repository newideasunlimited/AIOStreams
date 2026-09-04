import {
  DebridDownload,
  DebridError,
  DebridServiceConfig,
  PlaybackInfo,
  TorrentDebridService,
  convertStatusCodeToError,
} from './base.js';
import { constants, createLogger } from '../utils/index.js';

const logger = createLogger('debrid:realdebrid');
const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

function normaliseToken(token: string): string {
  return token
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^realdebrid:/i, '')
    .trim();
}

type RdTorrent = {
  id: string;
  filename?: string;
  hash?: string;
  bytes?: number;
  progress?: number;
  status?: string;
  added?: string;
  links?: string[];
  files?: Array<{
    id?: number;
    path?: string;
    bytes?: number;
    selected?: number;
  }>;
};

function mapStatus(status?: string): DebridDownload['status'] {
  switch (status) {
    case 'downloaded':
      return 'downloaded';
    case 'downloading':
      return 'downloading';
    case 'queued':
    case 'magnet_conversion':
    case 'waiting_files_selection':
      return 'queued';
    case 'error':
    case 'magnet_error':
    case 'virus':
    case 'dead':
      return 'failed';
    default:
      return 'unknown';
  }
}

export class RealDebridService implements TorrentDebridService {
  readonly serviceName = constants.REALDEBRID_SERVICE;
  readonly capabilities = { torrents: true, usenet: false } as const;

  private readonly token: string;
  private readonly clientIp?: string;

  constructor(config: DebridServiceConfig) {
    this.token = normaliseToken(config.token);
    this.clientIp = config.clientIp;
    if (!this.token) {
      throw new DebridError('Missing Real-Debrid API token', {
        statusCode: 401,
        statusText: 'Unauthorized',
        code: 'UNAUTHORIZED',
        headers: {},
        body: null,
      });
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(`${RD_BASE}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Accept', 'application/json');

    const response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15000),
    });

    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof body === 'object' && body?.error
          ? String(body.error)
          : `Real-Debrid request failed (${response.status})`;
      throw new DebridError(message, {
        statusCode: response.status,
        statusText: response.statusText,
        code: convertStatusCodeToError(response.status),
        headers: Object.fromEntries(response.headers.entries()),
        body,
        type: 'upstream_error',
      });
    }

    return body as T;
  }

  private form(data: Record<string, string>): URLSearchParams {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) form.set(key, value);
    if (this.clientIp) form.set('ip', this.clientIp);
    return form;
  }

  private async getInfo(id: string): Promise<RdTorrent> {
    return this.request<RdTorrent>(`/torrents/info/${encodeURIComponent(id)}`);
  }

  private toDownload(info: RdTorrent, cached = false): DebridDownload {
    const files = (info.files ?? []).map((file, index) => ({
      id: file.id,
      name: (file.path ?? '').replace(/^\//, '') || info.filename,
      path: file.path,
      size: file.bytes ?? 0,
      index,
      link: info.links?.[index],
    }));

    return {
      id: info.id,
      hash: info.hash?.toLowerCase(),
      name: info.filename,
      size: info.bytes,
      addedAt: info.added,
      status: cached && info.status === 'downloaded' ? 'cached' : mapStatus(info.status),
      files,
    };
  }

  async listMagnets(): Promise<DebridDownload[]> {
    const torrents = await this.request<RdTorrent[]>('/torrents', {}, { limit: 200 });
    return (Array.isArray(torrents) ? torrents : []).map((torrent) => ({
      id: torrent.id,
      hash: torrent.hash?.toLowerCase(),
      name: torrent.filename,
      size: torrent.bytes,
      addedAt: torrent.added,
      status: mapStatus(torrent.status),
      library: true,
    }));
  }

  async checkMagnets(
    magnets: string[],
    _sid?: string,
    checkOwned: boolean = true
  ): Promise<DebridDownload[]> {
    const hashes = [...new Set(magnets.map((hash) => hash.toLowerCase()))];
    if (hashes.length === 0) return [];

    const library = checkOwned ? await this.listMagnets() : [];
    const byHash = new Map(
      library.filter((item) => item.hash).map((item) => [item.hash!, item])
    );

    const results = await Promise.all(
      hashes.map(async (hash): Promise<DebridDownload> => {
        const owned = byHash.get(hash);
        if (owned) {
          try {
            const info = await this.getInfo(String(owned.id));
            const mapped = this.toDownload(info, info.status === 'downloaded');
            mapped.library = true;
            return mapped;
          } catch (error) {
            logger.warn('Failed to inspect existing Real-Debrid torrent', {
              hash,
              error: (error as Error).message,
            });
            return owned;
          }
        }

        let addedId: string | undefined;
        try {
          const added = await this.request<{ id: string }>('/torrents/addMagnet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: this.form({ magnet: `magnet:?xt=urn:btih:${hash}` }),
          });
          addedId = added?.id;
          if (!addedId) {
            return { id: -1, hash, status: 'unknown', files: [] };
          }

          await this.request<unknown>(`/torrents/selectFiles/${encodeURIComponent(addedId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: this.form({ files: 'all' }),
          });

          const info = await this.getInfo(addedId);
          if (info.status === 'downloaded') {
            return this.toDownload(info, true);
          }

          await this.removeMagnet(addedId).catch(() => {});
          return {
            id: -1,
            hash,
            status: mapStatus(info.status),
            size: info.bytes,
            files: (info.files ?? []).map((file, index) => ({
              id: file.id,
              name: (file.path ?? '').replace(/^\//, ''),
              path: file.path,
              size: file.bytes ?? 0,
              index,
            })),
          };
        } catch (error) {
          if (addedId) await this.removeMagnet(addedId).catch(() => {});
          if (error instanceof DebridError && error.code === 'UNAUTHORIZED') throw error;
          logger.debug('Real-Debrid cache probe failed', {
            hash,
            error: (error as Error).message,
          });
          return { id: -1, hash, status: 'unknown', files: [] };
        }
      })
    );

    logger.info('Real-Debrid native cache check complete', {
      checked: hashes.length,
      cached: results.filter((item) => item.status === 'cached').length,
    });
    return results;
  }

  async addMagnet(magnet: string): Promise<DebridDownload> {
    const added = await this.request<{ id: string }>('/torrents/addMagnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ magnet }),
    });
    if (!added?.id) {
      throw new DebridError('Real-Debrid did not return a torrent id', {
        statusCode: 502,
        statusText: 'Bad Gateway',
        code: 'BAD_GATEWAY',
        headers: {},
        body: added,
      });
    }

    await this.request<unknown>(`/torrents/selectFiles/${encodeURIComponent(added.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ files: 'all' }),
    });
    return this.toDownload(await this.getInfo(added.id));
  }

  async addTorrent(_torrent: string): Promise<DebridDownload> {
    throw new DebridError('Direct torrent-file upload is not enabled for Real-Debrid native mode', {
      statusCode: 501,
      statusText: 'Not Implemented',
      code: 'NOT_IMPLEMENTED',
      headers: {},
      body: null,
    });
  }

  async getMagnet(magnetId: string): Promise<DebridDownload> {
    return this.toDownload(await this.getInfo(magnetId));
  }

  async removeMagnet(magnetId: string): Promise<void> {
    await this.request<unknown>(`/torrents/delete/${encodeURIComponent(magnetId)}`, {
      method: 'DELETE',
    });
  }

  async generateTorrentLink(link: string, _clientIp?: string): Promise<string> {
    const result = await this.request<{ download?: string }>('/unrestrict/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ link }),
    });
    if (!result?.download) {
      throw new DebridError('Real-Debrid did not return a download URL', {
        statusCode: 502,
        statusText: 'Bad Gateway',
        code: 'BAD_GATEWAY',
        headers: {},
        body: result,
      });
    }
    return result.download;
  }

  async resolve(
    playbackInfo: PlaybackInfo,
    _filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (playbackInfo.type !== 'torrent') return undefined;

    let download = playbackInfo.serviceItemId
      ? await this.getMagnet(playbackInfo.serviceItemId)
      : await this.addMagnet(`magnet:?xt=urn:btih:${playbackInfo.hash}`);

    if (download.status !== 'downloaded') {
      if (!cacheAndPlay) return undefined;
      const started = Date.now();
      while (Date.now() - started < 120000) {
        if (signal?.aborted) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        download = await this.getMagnet(String(download.id));
        if (download.status === 'downloaded') break;
        if (['failed', 'invalid'].includes(download.status)) return undefined;
      }
      if (download.status !== 'downloaded') return undefined;
    }

    const info = await this.getInfo(String(download.id));
    const fileIndex = playbackInfo.fileIndex ?? playbackInfo.index ?? 0;
    const link = info.links?.[fileIndex] ?? info.links?.[0];
    if (!link) return undefined;

    const playbackUrl = await this.generateTorrentLink(link, this.clientIp);
    if (autoRemoveDownloads && !playbackInfo.serviceItemId) {
      this.removeMagnet(String(download.id)).catch(() => {});
    }
    return playbackUrl;
  }
}
