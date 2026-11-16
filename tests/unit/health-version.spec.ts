import { afterEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import { configureApp } from "../../src/index";
import { checkHealth } from "../../src/routes/health/health.service";
import { SIDECAR_VERSION } from "../../src/version";

// The wrapper's own version, apart from the slicer's. An install builds this
// image from the fork's branch whenever its operator rebuilds, independently
// of the BamDude it serves — so BamDude can only know whether the wrapper has
// a behaviour by asking. These run without a slicer: the health check then
// answers "unhealthy", and must still say what code is answering.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("the wrapper's code version", () => {
  it("is a whole number, so that 'at least N' is a plain comparison", () => {
    expect(Number.isInteger(SIDECAR_VERSION)).toBe(true);
    expect(SIDECAR_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("is reported by the health check beside the slicer's version", async () => {
    process.env.ORCASLICER_PATH = "/no/such/slicer";
    const health = await checkHealth();
    expect(health.sidecarVersion).toBe(SIDECAR_VERSION);
    expect(health.checks.orcaslicer.available).toBe(false);
  });

  it("is in the GET /health body even when the slicer is not available", async () => {
    process.env.ORCASLICER_PATH = "/no/such/slicer";
    const res = await supertest(configureApp()).get("/health").expect(503);
    expect(res.body.sidecarVersion).toBe(SIDECAR_VERSION);
    expect(res.body.status).toBe("unhealthy");
  });
});
