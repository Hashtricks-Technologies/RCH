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
    // Hold the door open while the load balancer notices. /readyz is already 503 (setDraining,
    // above) but the ALB health-checks every 15s and needs a failing check before it will
    // deregister this pod, and the target group then holds the connection for its own 30s
    // deregistration delay. Five seconds was less than one health-check interval: the pod
    // stopped accepting while the ALB was still sending it requests, which is a 502 in someone's
    // browser. Twenty is one interval plus the beat it takes for the last in-flight request to
    // arrive.
    //
    // The arithmetic, all three numbers together: 20s wait + 25s drain timer = 45s, inside the
    // 60s terminationGracePeriodSeconds set in deploy/chart/rch/templates/api-deployment.yaml,
    // after which the kubelet sends SIGKILL. Move one and move the others.
    await new Promise((r) => setTimeout(r, config.env === "production" ? 20_000 : 0));
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
