import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as PultPart from "./PultPart.ts";
import * as PultPartProxy from "./PultPartProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope>, state: PultPart.PultPartState) => {
  const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: { ...request.headers } });
      return HttpClientResponse.fromWeb(
        request,
        new Response("from the part", { headers: { "content-type": "text/plain" } }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    PultPartProxy.routeLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.effect(
          PultPart.PultPart,
          SubscriptionRef.make(state).pipe(
            Effect.map((ref) => PultPart.PultPart.of({ state: ref })),
          ),
        ),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests };
};

const ready: PultPart.PultPartState = {
  _tag: "Ready",
  dir: "/builds/a/part",
  origin: "http://127.0.0.1:4555",
  secret: "part-secret",
};

describe("server part proxy", () => {
  it("forwards below the prefix with the part's secret in place of the client's credentials", async () => {
    const { handler, requests } = fixture([AuthOrchestrationReadScope], ready);
    const response = await handler(
      new Request("http://t3.test/api/pult/part/board/items?wsTicket=ticket&page=2", {
        headers: { authorization: "Bearer client-token", cookie: "session=1", "x-kept": "yes" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from the part");
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4555/board/items?page=2",
    ]);
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer part-secret",
      "x-kept": "yes",
    });
    expect(requests[0]?.headers.cookie).toBeUndefined();
  });

  it("requires operate scope for anything but reads", async () => {
    const path = "http://t3.test/api/pult/part/board/items";
    const reader = fixture([AuthOrchestrationReadScope], ready);
    expect((await reader.handler(new Request(path, { method: "POST", body: "{}" }))).status).toBe(
      403,
    );
    expect(reader.requests).toEqual([]);
    const operator = fixture([AuthOrchestrationOperateScope], ready);
    const response = await operator.handler(new Request(path, { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it("answers 503 while the part is not running", async () => {
    const { handler, requests } = fixture([AuthOrchestrationReadScope], {
      _tag: "Down",
      reason: "the part exited",
    });
    const response = await handler(new Request("http://t3.test/api/pult/part/board"));
    expect(response.status).toBe(503);
    expect(requests).toEqual([]);
  });
});
