import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";

const worker = createExecutionContext().exports as unknown as {
  ScheduleAccount(options: { props: { accountId: string } }): {
    getVerifier(context: {authority: unknown}): Promise<{ verify(): Promise<void> }>;
  };
  TestVerifierAuthority(options: object): unknown;
  TestVerifierControl(options: object): {
    reset(): Promise<void>;
    getChecks(): Promise<number>;
  };
};

it("rechecks live app authority whenever the scheduler verifier is used", async () => {
  const account = worker.ScheduleAccount({ props: { accountId: "test-account" } });
  const authority = worker.TestVerifierAuthority({});
  const control = worker.TestVerifierControl({});
  await control.reset();

  await expect((await account.getVerifier({authority})).verify()).resolves.toBeUndefined();
  await expect(control.getChecks()).resolves.toBe(1);
});
