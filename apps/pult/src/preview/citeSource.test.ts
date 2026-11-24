import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { citeSource } from "./citeSource.ts";

// Minted by a dev server (`assets.createUrl`) for a thread whose checkout is /tmp/pult-cite-fixture.
const SERVER = "http://127.0.0.1:3794/";
const PAGE =
  "/api/assets/eyJ2ZXJzaW9uIjoxLCJraW5kIjoid29ya3NwYWNlLWZpbGUiLCJ3b3Jrc3BhY2VSb290IjoiL3ByaXZhdGUvdG1wL3B1bHQtY2l0ZS1maXh0dXJlIiwiYmFzZVJlbGF0aXZlUGF0aCI6Ii4iLCJlbnRyeUZpbGVOYW1lIjoiaW5kZXguaHRtbCIsImV4cGlyZXNBdCI6MTc5NTU2MDA2NTk5Mn0.z4IbSq1Dtn83TQePnvPxzlrmPdotjOyPtYP4iLoa8lU";
const EXACT =
  "/api/assets/eyJ2ZXJzaW9uIjoxLCJraW5kIjoid29ya3NwYWNlLWZpbGUtZXhhY3QiLCJ3b3Jrc3BhY2VSb290IjoiL3ByaXZhdGUvdG1wL3B1bHQtY2l0ZS1maXh0dXJlIiwicmVsYXRpdmVQYXRoIjoiZGlhZ3JhbS5zdmciLCJleHBpcmVzQXQiOjE3OTU1NjAwNjYwMzB9.x89WffQOaG6uRWjK-tcZD9VDMhKYaRDaBSDcj7T-4Ew";
const ATTACHMENT =
  "/api/assets/eyJ2ZXJzaW9uIjoxLCJraW5kIjoiYXR0YWNobWVudCIsImF0dGFjaG1lbnRJZCI6InB1bHRfcHJvYmUtMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxLWh0bWwiLCJtaW1lVHlwZSI6InRleHQvaHRtbCIsImV4cGlyZXNBdCI6MTc5NTU2MTIwMDAwMH0.NCwvChueK2PD6VC9Z4WqxT6Fu0oXPeZ_EFxWenQVRFo";

const file = (hostPath: string) => ({ kind: "file", hostPath });
const url = (url: string) => ({ kind: "url", url });

NodeTest.test("an asset URL of a project page names its file", () => {
  NodeAssert.deepEqual(
    citeSource(`${SERVER}${PAGE.slice(1)}/index.html`, SERVER),
    file("/private/tmp/pult-cite-fixture/index.html"),
  );
  // The browser may run on loopback while the environment answers elsewhere.
  NodeAssert.deepEqual(
    citeSource(`http://localhost:3794${PAGE}/index.html`, "https://box.example.ts.net/"),
    file("/private/tmp/pult-cite-fixture/index.html"),
  );
});

NodeTest.test("a page linked from the opened one names its own file", () => {
  NodeAssert.deepEqual(
    citeSource(`${SERVER}${PAGE.slice(1)}/sub/linked%20page.html`, SERVER),
    file("/private/tmp/pult-cite-fixture/sub/linked page.html"),
  );
});

NodeTest.test("an exact asset URL names its file", () => {
  NodeAssert.deepEqual(
    citeSource(`${SERVER}${EXACT.slice(1)}/diagram.svg`, SERVER),
    file("/private/tmp/pult-cite-fixture/diagram.svg"),
  );
});

NodeTest.test("any other page names its URL", () => {
  for (const page of [
    // Another origin serving the same path.
    `https://example.com${PAGE}/index.html`,
    // A dev server's page.
    "http://localhost:5173/settings?tab=2",
    // An attachment's asset, which no checkout holds.
    `${SERVER}${ATTACHMENT.slice(1)}/pult_probe-00000000-0000-4000-8000-000000000001-html.html`,
  ])
    NodeAssert.deepEqual(citeSource(page, SERVER), url(page));
});

NodeTest.test("claims that fail to decode name the URL", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const page = `${SERVER}api/assets/bm90IGpzb24.c2lnbmF0dXJl/index.html`;
  NodeAssert.deepEqual(citeSource(page, SERVER), url(page));
  NodeAssert.equal(warn.mock.callCount(), 1);
});
