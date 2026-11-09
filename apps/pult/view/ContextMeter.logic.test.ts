// Run with `node --test view/ContextMeter.logic.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { contextLevel, formatCost, formatPercentage } from "./ContextMeter.logic.ts";

NodeTest.describe("contextLevel", () => {
  NodeTest.it("is plain under 250k tokens and 75% of the window", () => {
    NodeAssert.equal(contextLevel({ usedTokens: 249_999, usedPercentage: 74.9 }), null);
  });

  NodeTest.it("is heavy from 250k tokens, whatever the window", () => {
    NodeAssert.equal(contextLevel({ usedTokens: 250_000, usedPercentage: 25 }), "heavy");
    NodeAssert.equal(contextLevel({ usedTokens: 300_000, usedPercentage: null }), "heavy");
  });

  NodeTest.it("is full from 75% of the window, however few the tokens", () => {
    NodeAssert.equal(contextLevel({ usedTokens: 150_000, usedPercentage: 75 }), "full");
    NodeAssert.equal(contextLevel({ usedTokens: 900_000, usedPercentage: 90 }), "full");
  });
});

NodeTest.describe("formatPercentage", () => {
  NodeTest.it("keeps one decimal under 10%, dropping a zero one", () => {
    NodeAssert.equal(formatPercentage(4.26), "4.3%");
    NodeAssert.equal(formatPercentage(4), "4%");
  });

  NodeTest.it("rounds from 10%", () => {
    NodeAssert.equal(formatPercentage(42.6), "43%");
  });

  NodeTest.it("has none for an unknown window", () => {
    NodeAssert.equal(formatPercentage(null), null);
    NodeAssert.equal(formatPercentage(Number.NaN), null);
  });
});

NodeTest.describe("formatCost", () => {
  NodeTest.it("shows cents, and four places under one", () => {
    NodeAssert.equal(formatCost({ amount: 1.5, currency: "USD" }), "USD 1.50");
    NodeAssert.equal(formatCost({ amount: 0.0042, currency: "USD" }), "USD 0.0042");
    NodeAssert.equal(formatCost({ amount: 0, currency: "USD" }), "USD 0.00");
  });
});
