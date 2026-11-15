# Navegador Headless F12 (100% GitHub)

Navegador *headless* con Puppeteer + Google Chrome oficial, consola F12, detección de `.mpd` (sin keys DRM) y tokens.

## Uso 100% en GitHub

### Opción A — GitHub Pages + GitHub Actions (sin servidor)
1. Creá un **repositorio privado** en GitHub y subí estos archivos.
2. Si la plataforma requiere login, agregá los secretos en **Settings → Secrets and variables → Actions**:
   - `PLATFORM_USER`
   - `PLATFORM_PASS`
   - (Opcional) `PLATFORM_LOGIN_URL`, `USER_SELECTOR`, `PASS_SELECTOR`, `SUBMIT_SELECTOR`
3. Activá **GitHub Pages** en **Settings → Pages → Deploy from a branch → `main` / `docs`**.
4. Abrí la URL de tu GitHub Pages, ingresá un **Fine-Grained PAT** con permiso *Actions (Read & Write)* sobre ese repo, elegí plataforma/canal y ejecutá. El resultado JSON y la captura quedan en los **Artifacts** del run.

### Opción B — GitHub Codespaces (panel HTML interactivo en vivo)
1. Abrí el repositorio en **Code → Codespaces → Create codespace on main**.
2. En la terminal del Codespace ejecutá:
   ```bash
   npm run panel
