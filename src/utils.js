import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_KEYWORDS = ['token', 'access_token', 'auth', 'jwt', 'bearer', 'session'];

export function parseArgs(argv) {
  const args = {
    platform: null,
    channel: null,
    url: null,
    keywords: [],
    waitMs: 5000,
    timeout: 30000,
    headless: true,
    testingBrowser: false,
    executablePath: null,
    profileDir: './chrome-drm-profile',
    devtoolsPort: null,
    once: false,
    save: false,
    screenshot: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);

    if (arg === '--platform' || arg === '-p') args.platform = next();
    else if (arg === '--channel' || arg === '-c') args.channel = next();
    else if (arg === '--url' || arg === '-u') args.url = next();
    else if (arg === '--keyword' || arg === '-k') {
      const kw = next();
      if (kw) args.keywords.push(kw.toLowerCase());
    } else if (arg === '--wait' || arg === '-w') args.waitMs = Number(next()) || 5000;
    else if (arg === '--timeout' || arg === '-t') args.timeout = Number(next()) || 30000;
    else if (arg === '--executable-path') args.executablePath = next();
    else if (arg === '--profile-dir') args.profileDir = next() || './chrome-drm-profile';
    else if (arg === '--devtools-port') args.devtoolsPort = Number(next()) || 9222;
    else if (arg === '--headed') args.headless = false;
    else if (arg === '--testing-browser') args.testingBrowser = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--save') args.save = true;
    else if (arg === '--screenshot') args.screenshot = true;
  }

  return args;
}

export function isHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isMpdManifest(rawUrl, contentType = '') {
  if (contentType.toLowerCase().includes('application/dash+xml')) return true;
  try {
    return new URL(rawUrl).pathname.toLowerCase().endsWith('.mpd');
  } catch {
    return rawUrl.toLowerCase().includes('.mpd');
  }
}

export function isDrmLicenseOrKey(rawUrl, contentType = '') {
  const combined = `${rawUrl} ${contentType}`.toLowerCase();
  return (
    combined.includes('license') ||
    combined.includes('widevine') ||
    combined.includes('clearkey') ||
    combined.includes('playready') ||
    combined.includes('fairplay') ||
    combined.includes('getkey')
  );
}

export function findMatchesInJson(data, keywords, currentPath = '$', results = []) {
  if (data === null || data === undefined) return results;

  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      findMatchesInJson(item, keywords, `${currentPath}[${index}]`, results);
    });
    return results;
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const nextPath = `${currentPath}.${key}`;
      if (
        keywords.some((kw) => key.toLowerCase().includes(kw)) &&
        (typeof value === 'string' || typeof value === 'number')
      ) {
        results.push({ path: nextPath, key, value: String(value) });
      }
      if (typeof value === 'object' && value !== null) {
        findMatchesInJson(value, keywords, nextPath, results);
      }
    }
  }

  return results;
}

export function findMatchesInUrlParams(rawUrl, keywords) {
  const matches = [];
  try {
    const parsed = new URL(rawUrl);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (keywords.some((kw) => key.toLowerCase().includes(kw))) {
        matches.push({ param: key, value });
      }
    }
  } catch {
    // URL inválida o relativa
  }
  return matches;
}

export async function loadPlatforms() {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), 'platforms.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
