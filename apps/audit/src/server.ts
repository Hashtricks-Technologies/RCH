import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type AuditConfig } from "./config.js";

function readConfig(): AuditConfig {
  try { return loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }
}

async function main() {
  const config = readConfig();
  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "draining");
    app.readiness.setDraining();
    // The API's numbers, for the API's reasons (apps/api/src/server.ts has the whole argument):
    // /readyz is 503 from here, the wait lets the pod leave the Service's endpoints and the load
    // balancer's target group before it stops accepting, and 30 s wait + 25 s drain = 55 s fits
    // inside a 60 s terminationGracePeriodSeconds. Change one and change the others with it.
    await new Promise((r) => setTimeout(r, config.env === "production" ? 30_000 : 0));
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
