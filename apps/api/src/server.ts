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
    // Hold the door open while the load balancer stops sending here. /readyz is already 503
    // (setDraining, above); what has to happen next is that this pod leaves the Service's
    // Endpoints - the readiness probe runs every 5s with failureThreshold 3, so 15s - and that
    // the AWS Load Balancer Controller then reconciles that removal into the target group. Those
    // two are what this wait is buying. The ALB's own health check (every 15s, on /readyz) is the
    // backstop behind them, not the thing driving the timing. Five seconds was shorter than the
    // endpoint removal alone: the pod stopped accepting while the load balancer was still
    // sending it requests, which is a 502 in somebody's browser.
    //
    // Thirty rather than twenty because of a constraint the two halves have to satisfy together:
    // the target group's deregistration delay is 30s
    // (alb.ingress.kubernetes.io/target-group-attributes), and that delay may never outlast this
    // wait. A pod that stops accepting while the target group is still draining connections into
    // it cuts exactly the requests the delay exists to let finish. **deregistration delay ≤
    // pre-drain wait** - move one and move the other.
    //
    // The arithmetic, all of it: 30s wait + the 25s drain timer below = 55s, inside the 60s
    // terminationGracePeriodSeconds set in deploy/chart/rch/templates/api-deployment.yaml, after
    // which the kubelet sends SIGKILL.
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
