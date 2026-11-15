import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseArgs } from './src/utils.js';
import { ChromeHeadlessConsole } from './src/browser.js';

async function main() {
  const args = parseArgs(process.argv);
  const consoleApp = new ChromeHeadlessConsole(args);

  const shutdown = async () => {
    await consoleApp.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await consoleApp.init();

    if (process.env.USE_LOGIN === 'true' && process.env.PLATFORM_USER && process.env.PLATFORM_PASS) {
      const platformCfg = args.platform ? consoleApp.platforms[args.platform] : null;
      const loginUrl = process.env.PLATFORM_LOGIN_URL || platformCfg?.loginUrl || args.url;

      if (loginUrl) {
        await consoleApp.login({
          loginUrl,
          username: process.env.PLATFORM_USER,
          password: process.env.PLATFORM_PASS,
          userSelector: process.env.USER_SELECTOR || platformCfg?.userSelector,
          passSelector: process.env.PASS_SELECTOR || platformCfg?.passSelector,
          submitSelector: process.env.SUBMIT_SELECTOR || platformCfg?.submitSelector
        });
      }
    }

    if (args.url) {
      await consoleApp.gotoUrl(args.url);
    } else if (args.platform && args.channel) {
      await consoleApp.openPlatformChannel(args.platform, args.channel);
    }

    if (args.once) {
      console.log('\n=== MPD ===\n', JSON.stringify(consoleApp.mpdStreams, null, 2));
      console.log('\n=== TOKENS ===\n', JSON.stringify(consoleApp.tokenFindings, null, 2));
      if (args.save) await consoleApp.saveReport();
      if (args.screenshot) await consoleApp.saveScreenshot();
      return;
    }

    consoleApp.printHelp();
    const rl = readline.createInterface({ input, output });

    try {
      while (true) {
        const line = await rl.question('chrome-f12> ');
        try {
          const keepGoing = await consoleApp.handleCommand(line);
          if (!keepGoing) break;
        } catch (cmdErr) {
          console.log(`[Error]: ${cmdErr.message}`);
        }
      }
    } finally {
      rl.close();
    }
  } catch (err) {
    console.error('[Error fatal]:', err.message);
    process.exitCode = 1;
  } finally {
    await consoleApp.close();
  }
}

main();
