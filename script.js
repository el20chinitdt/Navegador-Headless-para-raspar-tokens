const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    console.log("Iniciando navegador headless...");
    const browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();

    let capturedData = {
        timestamp: new Date().toISOString(),
        targetUrl: process.env.INPUT_URL,
        urlEncontrada: null,
        headers: {}
    };

    // Interceptor de red para cazar .m3u8, .mpd o tokens de IP
    page.on('request', interceptedRequest => {
        const url = interceptedRequest.url();
        if (url.includes('.m3u8') || url.includes('.mpd') || url.includes('token=')) {
            console.log('¡ENCONTRADO STREAM/TOKEN!', url);
            capturedData.urlEncontrada = url;
            capturedData.headers = interceptedRequest.headers();
        }
    });

    try {
        const targetUrl = process.env.INPUT_URL;
        const channelQuery = process.env.INPUT_CHANNEL;

        console.log(`Navegando a: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // Intentar autocompletar usuario y contraseña (busca por inputs típicos de tipo text/email y password)
        console.log("Rellenando credenciales...");
        await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 10000 }).catch(() => {});
        
        await page.type('input[type="text"], input[type="email"]', process.env.TARGET_USER);
        await page.type('input[type="password"]', process.env.TARGET_PASS);

        // Hacer clic en el botón de login (busca botones comunes)
        console.log("Haciendo login...");
        await Promise.all([
            page.click('button[type="submit"], input[type="submit"], .login-btn, #login-btn').catch(() => page.keyboard.press('Enter')),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);

        console.log("Login procesado. Buscando el canal especificado...");
        
        // Si el usuario especificó un canal/botón para presionar:
        if (channelQuery) {
            console.log(`Buscando elemento interactivo para: "${channelQuery}"`);
            
            // Intentar hacer clic buscando por texto exacto o parcial en elementos clickeables, o como selector CSS directo
            await page.evaluate((query) => {
                const elements = Array.from(document.querySelectorAll('a, button, div, span, li'));
                const match = elements.find(el => el.innerText && el.innerText.trim().toLowerCase().includes(query.toLowerCase()));
                if (match) {
                    match.click();
                } else {
                    // Intentar como selector CSS si no se encontró por texto
                    const cssMatch = document.querySelector(query);
                    if (cssMatch) cssMatch.click();
                }
            }, channelQuery);

            console.log("Clic de canal ejecutado. Esperando streams...");
        }

        // Dar margen para que carguen los segmentos de red
        await new Promise(resolve => setTimeout(resolve, 15000));

    } catch (error) {
        console.error("Error en la ejecución:", error);
        capturedData.error = error.message;
    } finally {
        await browser.close();
        fs.writeFileSync('token-result.json', JSON.stringify(capturedData, null, 2));
        console.log("Guardado en token-result.json");
    }
})();
