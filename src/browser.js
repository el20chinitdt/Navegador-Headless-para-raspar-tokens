import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import {
  DEFAULT_KEYWORDS,
  isHttpUrl,
  isMpdManifest,
  isDrmLicenseOrKey,
  findMatchesInJson,
  findMatchesInUrlParams,
  loadPlatforms
} from './utils.js';

function isStreamManifest(url = '', contentType = '') {
  if (isMpdManifest(url, contentType)) return true;
  const u = String(url).toLowerCase();
  const ct = String(contentType).toLowerCase();
  return (
    /\.m3u8(\?|$|#)/i.test(u) ||
    ct.includes('application/vnd.apple.mpegurl') ||
    ct.includes('application/x-mpegurl') ||
    ct.includes('application/dash+xml')
  );
}

function extractStreamUrlsFromJson(obj, found = new Set()) {
  if (typeof obj === 'string') {
    const matches = obj.match(/https?:\/\/[^\s"'<>]+/g);
    if (matches) {
      for (const u of matches) {
        if (/\.(mpd|m3u8)(\?|$|#)/i.test(u)) found.add(u);
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractStreamUrlsFromJson(item, found);
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) extractStreamUrlsFromJson(val, found);
  }
  return Array.from(found);
}

export class ChromeHeadlessConsole {
  constructor(options = {}) {
    this.options = {
      waitMs: 5000,
      timeout: 30000,
      headless: true,
      testingBrowser: false,
      executablePath: null,
      profileDir: './chrome-drm-profile',
      devtoolsPort: null,
      keywords: [],
      ...options
    };

    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.platforms = {};
    this.keywords =
      this.options.keywords?.length > 0 ? this.options.keywords : DEFAULT_KEYWORDS;

    this.liveMode = 'mpd';
    this.networkLog = [];
    this.mpdStreams = [];
    this.seenMpd = new Set();
    this.consoleLogs = [];
    this.tokenFindings = {
      requestHeaders: [],
      urlParams: [],
      jsonResponses: []
    };
  }

  isRunning() {
    return Boolean(this.browser && this.browser.connected && this.page && !this.page.isClosed());
  }

  async init() {
    this.platforms = await loadPlatforms();

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required'
    ];

    if (this.options.devtoolsPort) {
      launchArgs.push(`--remote-debugging-port=${this.options.devtoolsPort}`);
    }

    const launchOptions = {
      headless: this.options.headless,
      ignoreDefaultArgs: ['--disable-component-update'],
      userDataDir: path.resolve(process.cwd(), this.options.profileDir),
      args: launchArgs
    };

    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else if (!this.options.testingBrowser) {
      launchOptions.channel = 'chrome';
    }

    try {
      this.browser = await puppeteer.launch(launchOptions);
    } catch (err) {
      if (launchOptions.channel === 'chrome') {
        throw new Error(
          `No se pudo abrir Google Chrome oficial (${err.message}). ` +
          `Verificá que esté instalado, pasá --executable-path <ruta>, o usá --testing-browser.`
        );
      }
      throw err;
    }

    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    await this.page.setViewport({ width: 1366, height: 768 });
    this.page.setDefaultTimeout(this.options.timeout);

    this.cdp = await this.page.createCDPSession();
    await this.cdp.send('Network.enable');
    await this.cdp.send('Runtime.enable');

    this.attachDevToolsListeners();

    if (this.options.devtoolsPort) {
      console.log(`[F12 Gráfico] Abrí chrome://inspect en tu Chrome local (puerto ${this.options.devtoolsPort}).`);
    }
  }

  recordNetwork(entry) {
    if (isDrmLicenseOrKey(entry.url, entry.contentType)) return;

    this.networkLog.push(entry);
    if (this.networkLog.length > 500) this.networkLog.shift();

    if (isStreamManifest(entry.url, entry.contentType)) {
      if (!this.seenMpd.has(entry.url)) {
        this.seenMpd.add(entry.url);
        this.mpdStreams.push(entry);
        if (this.liveMode !== 'off') {
          console.log(`\n[F12 STREAM] ${entry.url}`);
        }
      }
      return;
    }

    if (this.liveMode === 'all') {
      console.log(`[NET ${entry.status ?? '...'}] (${entry.type}) ${entry.url}`);
    }
  }

  attachDevToolsListeners() {
    this.page.on('console', (msg) => {
      const entry = {
        time: new Date().toISOString(),
        type: msg.type(),
        text: msg.text()
      };
      this.consoleLogs.push(entry);
      if (this.consoleLogs.length > 200) this.consoleLogs.shift();

      if (this.liveMode === 'all' || msg.type() === 'error') {
        console.log(`[Console.${msg.type()}] ${msg.text()}`);
      }
    });

    this.page.on('pageerror', (err) => {
      this.consoleLogs.push({
        time: new Date().toISOString(),
        type: 'pageerror',
        text: err.message
      });
      console.log(`[PageError] ${err.message}`);
    });

    this.cdp.on('Network.responseReceived', (event) => {
      const { response, type } = event;
      this.recordNetwork({
        time: new Date().toISOString(),
        url: response.url,
        status: response.status,
        contentType: response.mimeType || '',
        type: `cdp:${type}`
      });
    });

    this.page.on('request', (request) => {
      const reqUrl = request.url();
      if (isDrmLicenseOrKey(reqUrl)) return;

      const headers = request.headers();
      if (headers.authorization || headers['x-access-token'] || headers['x-auth-token']) {
        this.tokenFindings.requestHeaders.push({
          url: reqUrl,
          type: request.resourceType(),
          authorization: headers.authorization || null,
          xAccessToken: headers['x-access-token'] || null,
          xAuthToken: headers['x-auth-token'] || null
        });
      }

      const paramMatches = findMatchesInUrlParams(reqUrl, this.keywords);
      if (paramMatches.length > 0) {
        this.tokenFindings.urlParams.push({ url: reqUrl, matches: paramMatches });
      }
    });

    this.page.on('response', async (response) => {
      const request = response.request();
      const resUrl = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';

      if (isDrmLicenseOrKey(resUrl, contentType)) return;

      this.recordNetwork({
        time: new Date().toISOString(),
        url: resUrl,
        status,
        contentType,
        type: request.resourceType()
      });

      const type = request.resourceType();
      if ((type === 'xhr' || type === 'fetch') && status >= 200 && status < 300) {
        if (contentType.includes('application/json')) {
          try {
            const json = await response.json();
            const matches = findMatchesInJson(json, this.keywords);
            if (matches.length > 0) {
              this.tokenFindings.jsonResponses.push({ url: resUrl, status, matches });
            }

            const embeddedStreams = extractStreamUrlsFromJson(json);
            for (const streamUrl of embeddedStreams) {
              this.recordNetwork({
                time: new Date().toISOString(),
                url: streamUrl,
                status: 200,
                contentType: streamUrl.toLowerCase().includes('.m3u8')
                  ? 'application/vnd.apple.mpegurl'
                  : 'application/dash+xml',
                type: 'json-extract'
              });
            }
          } catch {
            // Respuesta vacía o JSON no válido
          }
        }
      }
    });
  }

  clearLogs() {
    this.networkLog = [];
    this.mpdStreams = [];
    this.seenMpd.clear();
    this.consoleLogs = [];
    this.tokenFindings = { requestHeaders: [], urlParams: [], jsonResponses: [] };
  }

  async hasVideoElement() {
    for (const frame of this.page.frames()) {
      try {
        const count = await frame.evaluate(() => {
          const walk = (root) => {
            let n = root.querySelectorAll('video').length;
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) n += walk(el.shadowRoot);
            }
            return n;
          };
          return walk(document);
        });
        if (count > 0) return true;
      } catch {
        // Frame detached o cross-origin bloqueado
      }
    }
    return false;
  }

  async tryOpenChannel(channelName = '') {
    const hasVideo = await this.hasVideoElement();
    if (hasVideo && !channelName) return false;

    const target = String(channelName || '').trim().toLowerCase();

    const coords = await this.page.evaluate((query) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return (
          r.width >= 24 &&
          r.height >= 24 &&
          st.display !== 'none' &&
          st.visibility !== 'hidden' &&
          parseFloat(st.opacity || '1') > 0.05
        );
      };

      const isInNav = (el) => Boolean(el.closest('nav, header'));
      const candidates = Array.from(
        document.querySelectorAll(
          'a, button, [role="button"], .carousel__slide, [class*="channel" i], [class*="card" i], [class*="item" i], [class*="slide" i], img'
        )
      ).filter((el) => isVisible(el));

      let chosen = null;

      if (query) {
        const scored = [];
        for (const el of candidates) {
          const text = [
            el.innerText,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('alt'),
            el.getAttribute('data-name'),
            el.getAttribute('data-channel'),
            el.getAttribute('src'),
            el.querySelector('img')?.getAttribute('alt'),
            el.querySelector('img')?.getAttribute('title'),
            el.querySelector('img')?.getAttribute('src')
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          if (text.includes(query)) {
            const r = el.getBoundingClientRect();
            scored.push({ el, area: r.width * r.height });
          }
        }
        scored.sort((a, b) => a.area - b.area);
        if (scored.length) chosen = scored[0].el;
      }

      if (!chosen) {
        // Si no se especificó canal (o no hubo coincidencia), abre la primera tarjeta/logo del catálogo
        const gridCards = candidates.filter((el) => {
          if (isInNav(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 45 || r.height < 35) return false;
          if (r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.7) return false;
          if (el.tagName === 'IMG') {
            const src = (el.getAttribute('src') || '').toLowerCase();
            if (src.includes('logojoy') || src.includes('banner')) return false;
            return true;
          }
          return Boolean(el.querySelector('img')) || el.className.toString().toLowerCase().includes('slide');
        });
        if (gridCards.length) chosen = gridCards[0];
      }

      if (!chosen) return null;

      chosen.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const r = chosen.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        label: (chosen.innerText || chosen.getAttribute('alt') || chosen.getAttribute('title') || chosen.tagName).slice(0, 60)
      };
    }, target);

    if (!coords) {
      console.log('[Canal] No se encontró tarjeta/logo clickeable en la página.');
      return false;
    }

    console.log(`[Canal] Haciendo clic en "${coords.label.trim() || 'elemento'}" (${coords.x}, ${coords.y})...`);
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {}),
      this.page.mouse.click(coords.x, coords.y)
    ]);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  }

  async forcePlayAllPlayers() {
    const playSelectors = [
      '.vjs-big-play-button',
      '.shaka-play-button',
      '.jw-icon-playback',
      '.jw-display-icon-container',
      '.plyr__control--overlaid',
      '.bmpui-ui-hugeplaybacktogglebutton',
      '.clappr-play-button',
      '[data-shaka-player-container] button',
      'button[aria-label*="play" i]',
      'button[aria-label*="reproducir" i]',
      '[data-testid*="play" i]',
      '[class*="play-button" i]',
      '[class*="playButton" i]',
      '[class*="big-play" i]'
    ];

    for (let pass = 1; pass <= 2; pass++) {
      let anyPlaying = false;

      for (const frame of this.page.frames()) {
        try {
          // 1. Clic real en botones de play visibles dentro del frame
          for (const sel of playSelectors) {
            const btns = await frame.$$(sel).catch(() => []);
            for (const btn of btns) {
              const box = await btn.boundingBox().catch(() => null);
              if (box && box.width > 8 && box.height > 8) {
                console.log(`[Play Forzado] Clic en botón "${sel}" (paso ${pass})`);
                await btn.click().catch(() => {});
                await new Promise((r) => setTimeout(r, 400));
              }
            }
          }

          // 2. Forzar .play() en todos los <video> (incluyendo Shadow DOM)
          const res = await frame.evaluate(async () => {
            const videos = [];
            const collect = (root) => {
              videos.push(...root.querySelectorAll('video'));
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) collect(el.shadowRoot);
              }
            };
            collect(document);

            let playing = 0;
            let firstPausedBox = null;

            for (const v of videos) {
              try {
                v.muted = true;
                v.playsInline = true;
                await v.play().catch(() => {});
              } catch {}

              if (!v.paused && !v.ended) {
                playing++;
              } else if (!firstPausedBox) {
                const r = v.getBoundingClientRect();
                if (r.width > 20 && r.height > 20) {
                  firstPausedBox = {
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2)
                  };
                }
              }
            }
            return { total: videos.length, playing, firstPausedBox };
          });

          if (res.playing > 0) {
            anyPlaying = true;
          } else if (res.total > 0 && res.firstPausedBox && frame === this.page.mainFrame()) {
            console.log(`[Play Forzado] Clic en centro del <video> (${res.firstPausedBox.x}, ${res.firstPausedBox.y})`);
            await this.page.mouse.click(res.firstPausedBox.x, res.firstPausedBox.y).catch(() => {});
            await this.page.keyboard.press('Space').catch(() => {});
          }
        } catch {
          // Frame inaccesible o cerrado
        }
      }

      if (anyPlaying || this.mpdStreams.length > 0) {
        console.log('[Play Forzado] Reproductor activo.');
        break;
      }

      if (pass < 2) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async gotoUrl(targetUrl, waitMs = this.options.waitMs) {
    if (!isHttpUrl(targetUrl)) {
      throw new Error('La URL debe comenzar con http:// o https://');
    }

    const normalize = (u) => u.replace(/\/+$/, '');
    const current = normalize(this.page.url() || '');
    const desired = normalize(targetUrl);

    if (current !== desired) {
      console.log(`[Navegando] ${targetUrl} ...`);
      await this.page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: this.options.timeout
      });
    } else {
      console.log(`[En página] Ya estamos en ${targetUrl}, evitando recarga.`);
    }

    await new Promise((r) => setTimeout(r, 2000));

    // Si estamos en una grilla de canales/logos sin video, intenta entrar al canal
    await this.tryOpenChannel(this.options.channel);

    // Fuerza Play en cualquier reproductor (HTML5, Video.js, Shaka, JWPlayer, iframes, etc.)
    await this.forcePlayAllPlayers();

    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    const title = await this.page.title().catch(() => '');
    console.log(`[Listo] Título: "${title}" | URL actual: ${this.page.url()}`);
  }

  async login({
    loginUrl,
    username,
    password,
    userSelector = 'input[type="email"], input[name="username"], #username',
    passSelector = 'input[type="password"]',
    submitSelector = 'button[type="submit"]'
  }) {
    if (!username || !password) return;
    if (!isHttpUrl(loginUrl)) {
      throw new Error('La URL de login debe comenzar con http:// o https://');
    }

    console.log(`[Login] Abriendo formulario en ${loginUrl} ...`);
    await this.page.goto(loginUrl, {
      waitUntil: 'networkidle2',
      timeout: this.options.timeout
    });

    await this.page.waitForSelector(userSelector, { timeout: 15000 });
    await this.page.click(userSelector, { clickCount: 3 });
    await this.page.type(userSelector, username, { delay: 20 });

    await this.page.waitForSelector(passSelector, { timeout: 15000 });
    await this.page.click(passSelector, { clickCount: 3 });
    await this.page.type(passSelector, password, { delay: 20 });

    if (submitSelector) {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        this.page.click(submitSelector)
      ]);
    } else {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        this.page.keyboard.press('Enter')
      ]);
    }

    await new Promise((r) => setTimeout(r, 2500));
    console.log(`[Login] Paso completado. URL actual: ${this.page.url()}`);
  }

  async openPlatformChannel(platformName, channelName) {
    const config = this.platforms[platformName];
    if (!config) {
      throw new Error(`Plataforma "${platformName}" no encontrada en platforms.json.`);
    }
    if (Array.isArray(config.keywords) && this.options.keywords.length === 0) {
      this.keywords = config.keywords.map((k) => k.toLowerCase());
    }
    this.options.channel = channelName;
    const targetUrl = config.urlTemplate.replace('{canal}', encodeURIComponent(channelName));
    await this.gotoUrl(targetUrl);
  }

  async evalExpression(expression) {
    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });

      if (res.exceptionDetails) {
        return {
          ok: false,
          error: res.exceptionDetails.exception?.description || res.exceptionDetails.text
        };
      }

      return { ok: true, value: res.result.value };
    } catch {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: false,
        userGesture: true
      });

      if (res.exceptionDetails) {
        return { ok: false, error: res.exceptionDetails.text };
      }
      return { ok: true, value: res.result.description || res.result.type };
    }
  }

  async evalInConsole(expression) {
    const res = await this.evalExpression(expression);
    if (!res.ok) {
      console.log(`[Uncaught Error] ${res.error}`);
      return;
    }
    console.log(util.inspect(res.value, { colors: true, depth: 4 }));
  }

  async getDom(selector = 'body') {
    const html = await this.page.$eval(selector, (el) => el.outerHTML);
    console.log(html);
  }

  async getStorage() {
    return this.page.evaluate(() => {
      const dump = (store) => {
        const out = {};
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            out[k] = store.getItem(k);
          }
        } catch {
          return { error: 'Acceso restringido' };
        }
        return out;
      };
      return {
        localStorage: dump(window.localStorage),
        sessionStorage: dump(window.sessionStorage)
      };
    });
  }

  async getDrmStatus() {
    return this.page.evaluate(async () => {
      const status = {
        secureContext: Boolean(window.isSecureContext),
        emeSupported: typeof navigator.requestMediaKeySystemAccess === 'function',
        widevineAvailable: false,
        error: null
      };
      if (!status.secureContext || !status.emeSupported) return status;
      try {
        await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [
          {
            initDataTypes: ['cenc'],
            videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
          }
        ]);
        status.widevineAvailable = true;
      } catch (err) {
        status.error = err?.message || 'Widevine no disponible';
      }
      return status;
    });
  }

  async getSnapshotState() {
    if (!this.isRunning()) {
      return { running: false };
    }

    return {
      running: true,
      currentUrl: this.page.url(),
      title: await this.page.title().catch(() => ''),
      drm: await this.getDrmStatus().catch(() => null),
      mpdStreams: this.mpdStreams,
      tokenFindings: this.tokenFindings,
      storage: await this.getStorage().catch(() => ({})),
      cookies: await this.context.cookies().catch(() => []),
      consoleLogs: this.consoleLogs.slice(-80),
      networkLog: this.networkLog.slice(-150)
    };
  }

  async saveReport() {
    const outDir = path.resolve(process.cwd(), 'output');
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `f12-report-${Date.now()}.json`);
    const snapshot = await this.getSnapshotState();
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8');
    console.log(`[Guardado] ${file}`);
    return file;
  }

  async saveScreenshot() {
    const outDir = path.resolve(process.cwd(), 'output');
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `screenshot-${Date.now()}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    console.log(`[Captura] ${file}`);
    return file;
  }

  async getScreenshotBuffer() {
    return this.page.screenshot({ type: 'png', fullPage: false });
  }

  printHelp() {
    console.log(`
Comandos tipo DevTools / Navegador:
  <cualquier código JS>        Ejecuta directo en la Consola F12 (ej: document.title)
  /goto <url>                  Navega a una URL
  /channel <plat> <canal>      Abre plataforma de platforms.json con ese canal
  /mpd                         Muestra los manifiestos .mpd/.m3u8 detectados (sin keys)
  /net [filtro]                Muestra peticiones Network (ej: /net .mpd o /net token)
  /tokens                      Muestra tokens detectados en headers, URLs y JSON
  /dom [selector]              Muestra el HTML del selector (pestaña Elements)
  /storage                     Muestra localStorage y sessionStorage (Application)
  /cookies                     Muestra cookies del contexto actual (Application)
  /drm                         Verifica estado de Widevine / EME
  /click <selector>            Hace clic en un elemento CSS (ej: /click button.play)
  /type <selector> <texto>     Escribe texto en un campo
  /reload | /back              Recarga o vuelve atrás
  /live <off|mpd|all>          Controla logs en vivo (por defecto: mpd)
  /clear                       Limpia logs de red en memoria
  /screenshot                  Guarda captura en ./output
  /save                        Exporta reporte JSON completo en ./output
  /exit                        Cierra el navegador y sale
`);
  }

  async handleCommand(line) {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (!trimmed.startsWith('/')) {
      await this.evalInConsole(trimmed);
      return true;
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);

    switch (cmd.toLowerCase()) {
      case '/help':
        this.printHelp();
        break;
      case '/exit':
      case '/quit':
        return false;
      case '/goto':
        if (!rest[0]) console.log('Uso: /goto <url>');
        else await this.gotoUrl(rest[0]);
        break;
      case '/channel':
        if (rest.length < 2) console.log('Uso: /channel <plataforma> <canal>');
        else await this.openPlatformChannel(rest[0], rest.slice(1).join(' '));
        break;
      case '/mpd':
        console.log(JSON.stringify(this.mpdStreams, null, 2));
        break;
      case '/net': {
        const filter = (rest[0] || '').toLowerCase();
        const items = filter
          ? this.networkLog.filter(
              (n) => n.url.toLowerCase().includes(filter) || n.contentType.toLowerCase().includes(filter)
            )
          : this.networkLog.slice(-30);
        console.log(JSON.stringify(items, null, 2));
        break;
      }
      case '/tokens':
        console.log(JSON.stringify(this.tokenFindings, null, 2));
        break;
      case '/dom':
        await this.getDom(rest.join(' ') || 'body');
        break;
      case '/storage':
        console.log(JSON.stringify(await this.getStorage(), null, 2));
        break;
      case '/cookies':
        console.log(JSON.stringify(await this.context.cookies(), null, 2));
        break;
      case '/drm':
        console.log(JSON.stringify(await this.getDrmStatus(), null, 2));
        break;
      case '/click':
        if (!rest[0]) console.log('Uso: /click <selector>');
        else await this.page.click(rest.join(' '));
        break;
      case '/type':
        if (rest.length < 2) console.log('Uso: /type <selector> <texto>');
        else await this.page.type(rest[0], rest.slice(1).join(' '));
        break;
      case '/reload':
        await this.page.reload({ waitUntil: 'networkidle2' });
        break;
      case '/back':
        await this.page.goBack({ waitUntil: 'networkidle2' });
        break;
      case '/live':
        if (['off', 'mpd', 'all'].includes(rest[0])) {
          this.liveMode = rest[0];
          console.log(`[Live] Modo cambiado a: ${this.liveMode}`);
        } else {
          console.log('Uso: /live <off|mpd|all>');
        }
        break;
      case '/clear':
        this.clearLogs();
        console.log('[Limpieza] Logs de red reiniciados.');
        break;
      case '/screenshot':
        await this.saveScreenshot();
        break;
      case '/save':
        await this.saveReport();
        break;
      default:
        console.log(`Comando desconocido: ${cmd}. Escribí /help para ver opciones.`);
    }

    return true;
  }

  async close() {
    if (this.cdp) await this.cdp.detach().catch(() => {});
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.cdp = null;
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
