import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Store } from '../../infrastructure/src/store.js';
import type { ProcessRunner } from '../../infrastructure/src/process.js';
import type { CultureBundle } from '../../core/src/creative-domain.js';
import { hash, invariant } from '../../core/src/util.js';

export function publicAddress(address: string) {
  if (address.includes(':')) return /^2[0-9a-f]{3}:/i.test(address); // public global-unicast only; excludes mapped/private/loopback IPv6
  const [a, b] = address.split('.').map(Number);
  return (
    a !== undefined &&
    b !== undefined &&
    a > 0 &&
    a < 224 &&
    a !== 127 &&
    a !== 10 &&
    a !== 169 &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}
export function cultureUrl(raw: string) {
  const url = new URL(raw);
  invariant(
    url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'),
    'CULTURE_URL',
    'Public HTTPS pages only',
  );
  invariant(
    !isIP(url.hostname) && url.hostname.includes('.') && !/\.(local|internal|localhost)$/i.test(url.hostname),
    'CULTURE_URL',
    'Local addresses are not cultural sources',
  );
  return url;
}
const plain = (s: string) =>
  s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
export class CultureWeb {
  constructor(
    readonly store: Store,
    readonly taskId: string,
    readonly runner: ProcessRunner,
  ) {}
  private async get(raw: string) {
    invariant(
      this.store.task(this.taskId).spec.creative.knowledge === 'web',
      'CAPABILITY_DENIED',
      'Web knowledge is disabled',
    );
    const url = cultureUrl(raw);
    const addresses = await lookup(url.hostname, { all: true });
    invariant(
      addresses.length && addresses.every((a) => publicAddress(a.address)),
      'CULTURE_URL',
      'Source resolves to a private or reserved address',
    );
    const address = addresses.find((a) => a.family === 4)?.address ?? addresses[0]!.address;
    const destination = address.includes(':') ? `[${address}]` : address;
    // Pin the CONNECT destination to the checked public IP, preserving TLS verification of the URL host.
    // No redirects, cookies, credentials or arbitrary shell.
    return (
      await this.runner.run(
        'curl',
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '25',
          '--max-filesize',
          '2000000',
          '--proto',
          '=https',
          '--user-agent',
          'FilmEdit/0.1 (local creative research)',
          '--connect-to',
          `${url.hostname}:443:${destination}:443`,
          '--url',
          url.href,
        ],
        { domains: [address], timeoutMs: 30000 },
      )
    ).stdout;
  }
  record(url: string, text: string) {
    const source = { url, text: text.slice(0, 12000), observedAt: new Date().toISOString() };
    this.store.saveArtifact(this.taskId, `culture.fetch.${hash(url)}`, source, true);
    return source;
  }
  async fetch(url: string) {
    return this.record(url, plain(await this.get(url)));
  }
  async search(query: string, language: 'zh' | 'en' = 'zh') {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    url.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      list: 'search',
      srsearch: query,
      srlimit: '6',
      utf8: '1',
    }).toString();
    const data = JSON.parse(await this.get(url.href));
    invariant(Array.isArray(data.query?.search), 'CULTURE_SEARCH', 'Wikipedia returned no search response');
    return data.query.search.map((r: { title: string; snippet: string; pageid: number }) => {
      const source = this.record(`https://${language}.wikipedia.org/?curid=${r.pageid}`, plain(r.snippet));
      return { title: r.title, ...source };
    });
  }
  verify(bundle: CultureBundle): CultureBundle {
    return {
      ...bundle,
      sources: bundle.sources.map((s) => {
        const fetched = this.store.artifact<{ url: string; text: string; observedAt: string }>(
          this.taskId,
          `culture.fetch.${hash(s.url)}`,
        )?.data;
        invariant(
          fetched && plain(fetched.text).includes(plain(s.excerpt)),
          'CREATIVE_SOURCE',
          `Source ${s.id} needs an excerpt from culture_search or web_fetch; do not invent citations`,
        );
        return { ...s, observedAt: fetched.observedAt };
      }),
    };
  }
}
