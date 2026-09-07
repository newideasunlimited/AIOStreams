import { resolveSrv } from 'node:dns/promises';

const RADIO_BROWSER_SRV = '_api._tcp.radio-browser.info';
const FALLBACK_HOST = 'de1.api.radio-browser.info';
const CACHE_MS = 10 * 60_000;
const USER_AGENT = 'Master-Addon/2.0';

let cachedHosts: { expires: number; hosts: string[] } | undefined;

async function getHosts(): Promise<string[]> {
  if (cachedHosts && cachedHosts.expires > Date.now()) return cachedHosts.hosts;

  const hosts: string[] = [];
  try {
    const records = await resolveSrv(RADIO_BROWSER_SRV);
    for (const record of records) {
      const host = record.name.replace(/\.$/, '').trim();
      if (host && !hosts.includes(host)) hosts.push(host);
    }
  } catch {
    // Radio Browser explicitly recommends server discovery with failover. If DNS
    // discovery is temporarily unavailable, retain one known server as a last
    // resort rather than taking Radio down with it.
  }

  if (!hosts.includes(FALLBACK_HOST)) hosts.push(FALLBACK_HOST);

  // Do not hammer the same public mirror first on every request/container.
  for (let i = hosts.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
  }

  cachedHosts = { expires: Date.now() + CACHE_MS, hosts };
  return hosts;
}

export async function fetchRadioBrowserJson<T>(
  path: string,
  params?: URLSearchParams
): Promise<T> {
  let lastError: unknown;
  const hosts = await getHosts();

  for (const host of hosts) {
    try {
      const url = new URL(path, `https://${host}`);
      if (params) {
        for (const [key, value] of params.entries()) {
          url.searchParams.append(key, value);
        }
      }
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        lastError = new Error(`${host} returned ${response.status}`);
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No Radio Browser server was reachable');
}
