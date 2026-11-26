import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BankIdApiError,
  BankIdTransportError,
  createBankIdClient,
  type BankIdTransportResponse,
  type CollectResponse,
} from "../src/index.ts";

const orderRef = "131daac9-16c6-4618-beb0-365768f37288";
const pending = (hintCode: string) => ({
  orderRef,
  status: "pending",
  hintCode,
});
const complete = {
  orderRef,
  status: "complete",
  completionData: { user: { personalNumber: "200001012384" } },
};
const json = (status: number, body: unknown): BankIdTransportResponse => ({
  status,
  body: JSON.stringify(body),
});

/** A client whose transport answers collects from a script, recording when. */
const scripted = (responses: BankIdTransportResponse[]) => {
  const calls: number[] = [];
  const client = createBankIdClient({
    environment: "test",
    transport: async request => {
      expect(request.path).toBe("/collect");
      expect(request.body).toEqual({ orderRef });
      calls.push(Date.now());
      const response = responses.shift();
      if (!response) throw new Error("collected too often");
      return response;
    },
  });
  return { client, calls };
};

/** Runs an iteration to the end in the background. */
const drain = (iterator: AsyncIterable<CollectResponse>) => {
  const results: CollectResponse[] = [];
  const done = (async () => {
    for await (const result of iterator) results.push(result);
  })();
  return { results, done };
};

describe("watch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects at once, then every 2 seconds, and ends after complete", async () => {
    const { client, calls } = scripted([
      json(200, pending("outstandingTransaction")),
      json(200, pending("userSign")),
      json(200, complete),
    ]);
    const { results, done } = drain(client.watch(orderRef));

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([0, 2000]);
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(calls).toEqual([0, 2000, 4000]);
    expect(results.map(r => r.status)).toEqual([
      "pending",
      "pending",
      "complete",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
  });

  it("ends after failed and never collects again", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(200, { orderRef, status: "failed", hintCode: "userCancel" }),
    ]);
    const { results, done } = drain(client.watch(orderRef));
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(results.at(-1)).toMatchObject({ status: "failed" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0, 2000]);
  });

  it("decides to stop before yielding, so a consumer changing the result cannot keep it collecting", async () => {
    const { client, calls } = scripted([
      json(200, complete),
      json(200, pending("userSign")),
    ]);
    const results: string[] = [];
    for await (const result of client.watch(orderRef)) {
      results.push(result.status);
      (result as { status: string }).status = "pending";
    }
    expect(results).toEqual(["complete"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0]);
  });

  it("throws invalidResponse for a result of another order", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(200, { ...complete, orderRef: "another-order" }),
    ]);
    const { results, done } = drain(client.watch(orderRef));
    const error = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await error).toMatchObject({
      name: "BankIdTransportError",
      reason: "invalidResponse",
      path: "/collect",
    });
    expect(results.map(r => r.status)).toEqual(["pending"]);
    expect(calls).toEqual([0, 2000]);
  });

  it("uses intervalMs", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(200, complete),
    ]);
    const { done } = drain(client.watch(orderRef, { intervalMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(calls).toEqual([0, 500]);
  });

  it("rejects an invalid intervalMs", async () => {
    const { client } = scripted([]);
    for (const intervalMs of [0, -1, Number.NaN, Infinity, 0.5, 2_147_483_648])
      await expect(
        client.watch(orderRef, { intervalMs }).next(),
      ).rejects.toThrow(
        "watch: intervalMs must be a whole number from 1 to 2147483647",
      );
  });

  it("ends when aborted while waiting, and leaves no timer", async () => {
    const { client, calls } = scripted([json(200, pending("userSign"))]);
    const controller = new AbortController();
    const { results, done } = drain(
      client.watch(orderRef, { signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await done;
    expect(results).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0]);
  });

  it("ends when aborted during a collect", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const client = createBankIdClient({
      environment: "test",
      transport: ({ signal }) => {
        calls.push(Date.now());
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    });
    const { results, done } = drain(
      client.watch(orderRef, { signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await done;
    expect(results).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0]);
  });

  it("does not collect when the signal is already aborted", async () => {
    const { client, calls } = scripted([]);
    const { results, done } = drain(
      client.watch(orderRef, { signal: AbortSignal.abort() }),
    );
    await done;
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("stops and leaves no timer when the loop is left early", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(200, pending("userSign")),
    ]);
    const done = (async () => {
      for await (const result of client.watch(orderRef)) {
        expect(result.status).toBe("pending");
        break;
      }
    })();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0]);
  });

  it("retries a retryable error silently at the same interval", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(503, {}),
      json(503, { errorCode: "maintenance", details: "" }),
      json(200, complete),
    ]);
    const { results, done } = drain(client.watch(orderRef));
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    expect(calls).toEqual([0, 2000, 4000, 6000]);
    expect(results.map(r => r.status)).toEqual(["pending", "complete"]);
  });

  it("throws the last error after 5 consecutive retries by default", async () => {
    const { client, calls } = scripted(
      Array.from({ length: 10 }, () =>
        json(503, { errorCode: "maintenance", details: "" }),
      ),
    );
    const { results, done } = drain(client.watch(orderRef));
    const error = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await error).toMatchObject({ errorCode: "maintenance" });
    expect(results).toEqual([]);
    // The first collect and 5 retries.
    expect(calls).toEqual([0, 2000, 4000, 6000, 8000, 10_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts only consecutive retries, resetting after a result", async () => {
    const maintenance = json(503, { errorCode: "maintenance", details: "" });
    const { client } = scripted([
      maintenance,
      maintenance,
      json(200, pending("userSign")),
      maintenance,
      maintenance,
      json(200, complete),
    ]);
    const { results, done } = drain(
      client.watch(orderRef, { maxConsecutiveRetries: 2 }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(results.map(r => r.status)).toEqual(["pending", "complete"]);
  });

  it("accepts maxConsecutiveRetries up to 100", async () => {
    const { client } = scripted([json(200, pending("userSign"))]);
    const watch = client.watch(orderRef, { maxConsecutiveRetries: 100 });
    await expect(watch.next()).resolves.toMatchObject({ done: false });
    await watch.return();
  });

  it("keeps watching a pending result without a hint code", async () => {
    const { client, calls } = scripted([
      json(200, { orderRef, status: "pending" }),
      json(200, complete),
    ]);
    const { results, done } = drain(client.watch(orderRef));
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(results).toEqual([{ orderRef, status: "pending" }, complete]);
    expect(calls).toEqual([0, 2000]);
  });

  it("uses maxConsecutiveRetries, where 0 retries nothing", async () => {
    const { client, calls } = scripted([
      json(503, { errorCode: "maintenance", details: "" }),
    ]);
    const error = await drain(
      client.watch(orderRef, { maxConsecutiveRetries: 0 }),
    ).done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdApiError);
    expect(calls).toEqual([0]);
  });

  it("rejects an invalid maxConsecutiveRetries", async () => {
    const { client } = scripted([]);
    for (const maxConsecutiveRetries of [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      101,
      2 ** 53,
      Number.MAX_VALUE,
      "3" as unknown as number,
    ])
      await expect(
        client.watch(orderRef, { maxConsecutiveRetries }).next(),
      ).rejects.toThrow("maxConsecutiveRetries must be");
  });

  it("throws any other error and stops", async () => {
    const { client, calls } = scripted([
      json(200, pending("userSign")),
      json(400, { errorCode: "invalidParameters", details: "No such order" }),
    ]);
    const { results, done } = drain(client.watch(orderRef));
    const error = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await error).toBeInstanceOf(BankIdApiError);
    expect(results).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([0, 2000]);
  });

  it("throws a transport error, which is never retryable", async () => {
    const client = createBankIdClient({
      environment: "test",
      transport: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const error = await drain(client.watch(orderRef)).done.catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
