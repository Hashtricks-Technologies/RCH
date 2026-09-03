import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

async function main() {
  let config;
  try { config = loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }

  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "draining");
    app.readiness.setDraining();
    // Give the load balancer one probe interval to notice /readyz is 503 before we stop accepting.
    await new Promise((r) => setTimeout(r, config.env === "production" ? 5000 : 0));
    const timer = setTimeout(() => { app.log.error("drain timed out"); process.exit(1); }, 25_000);
    await app.close();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
main().catch((e) => { console.error(e); process.exit(1); });
