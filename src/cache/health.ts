import type { FastifyInstance } from "fastify";
import type { Cache } from "./types.js";

function payloadTime(payload: unknown): string {
  if (payload && typeof payload === "object" && "time" in payload && typeof payload.time === "string") {
    return payload.time;
  }
  return new Date().toISOString();
}

export function registerDependencyReadiness(app: FastifyInstance, cache: Cache): void {
  app.addHook("preSerialization", async (request, reply, payload) => {
    if (request.method !== "GET" || request.routeOptions.url !== "/api/health") return payload;

    const databaseReady = reply.statusCode < 400;
    const cacheReadiness = await cache.readiness();
    const cacheReady = cacheReadiness.status !== "unavailable";
    const ready = databaseReady && cacheReady;
    // Redis protects login and coordinates temporary work, but PostgreSQL remains
    // the accounting source of truth. Keep serving authenticated accounting traffic
    // during a cache outage while reporting a degraded state for active alerting.
    reply.status(databaseReady ? 200 : 503);

    return {
      status: ready ? "ok" : (databaseReady ? "degraded" : "unavailable"),
      time: payloadTime(payload),
      dependencies: {
        database: { status: databaseReady ? "ready" : "unavailable" },
        cache: cacheReadiness,
      },
    };
  });
}
