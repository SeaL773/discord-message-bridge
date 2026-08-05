import { loadConfig, loadOrCreateToken } from "./config.js";
import { BridgeServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await loadOrCreateToken(config.tokenPath);
  console.log(`Bridge token path: ${config.tokenPath}`);

  const bridge = new BridgeServer({ config, token });
  await bridge.start();
  console.log(`Discord message bridge listening on http://${config.host}:${String(config.port)}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      }
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
