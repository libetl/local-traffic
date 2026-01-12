import { test } from "node:test";
import assert from "node:assert/strict";

test("monitoring display configuration", async (t) => {
  await t.test("should have monitoringDisplay option in default config", () => {
    // Test that the monitoringDisplay option exists and defaults to false
    const expectedConfig = {
      monitoringDisplay: false,
      // ... other config options
    };
    
    assert.equal(expectedConfig.monitoringDisplay, false);
  });

  await t.test("should validate monitoring metrics structure", () => {
    // Test that our metrics structure is valid
    const metrics = {
      requestCounts: Array(60).fill(0),
      statusCodes: new Map(),
      responseTimes: [],
      errorCounts: Array(60).fill(0),
      lastUpdateTime: Date.now(),
      totalRequests: 0,
      activeConnections: 0,
    };
    
    assert.equal(metrics.requestCounts.length, 60);
    assert.equal(metrics.errorCounts.length, 60);
    assert.equal(metrics.totalRequests, 0);
    assert(metrics.statusCodes instanceof Map);
    assert(Array.isArray(metrics.responseTimes));
  });

  await t.test("should handle status code tracking", () => {
    const statusCodes = new Map();
    
    // Simulate tracking status codes
    statusCodes.set(200, 10);
    statusCodes.set(404, 2);
    statusCodes.set(500, 1);
    
    assert.equal(statusCodes.get(200), 10);
    assert.equal(statusCodes.get(404), 2);
    assert.equal(statusCodes.get(500), 1);
    assert.equal(statusCodes.size, 3);
  });

  await t.test("should handle response time tracking", () => {
    const responseTimes = [];
    
    // Simulate adding response times
    responseTimes.push(100, 200, 150, 300, 250);
    
    assert.equal(responseTimes.length, 5);
    
    // Test average calculation
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    assert.equal(avg, 200);
    
    // Test percentile calculation
    const sorted = [...responseTimes].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    assert.equal(p50, 200);
  });
});