import { describe, expect, it } from "vitest";
import type {
  ContextAuthority, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVerifierContext,
  VerifierAppAuthority,
} from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUserWithAccount(vendorId: string) {
  const verifier = {} as Fetcher<GatekeeperUserVerifier>;
  const authority = {} as Fetcher<VerifierAppAuthority & ContextAuthority>;
  let verifierRequests = 0;
  let verifierContext: GatekeeperVerifierContext | undefined;
  let authorityProps: unknown;
  const account = {
    async getVerifier(context: GatekeeperVerifierContext) {
      verifierRequests++;
      verifierContext = context;
      return verifier;
    },
  } as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    centralAuthMode: false,
    vendors: new Map([["notion", {}], ["linear", {}]]),
    ctx: {
      id: {toString: () => "user-do-id"},
      exports: {
        GatekeeperVerifierAuthority: ({props}: {props: unknown}) => {
          authorityProps = props;
          return authority;
        },
      },
    },
    storage: {
      profile: {
        get: () => ({id: "subject-a"}),
      },
      connectedAccounts: {
        get: (accountId: number) => accountId === 7
          ? { id: accountId, account, vendorId }
          : undefined,
      },
    },
  });
  return {
    user,
    verifier,
    authority,
    authorityProps: () => authorityProps,
    verifierContext: () => verifierContext,
    verifierRequests: () => verifierRequests,
  };
}

describe("UserDurableObject.getVerifier", () => {
  it("returns a verifier with durable live authority for the exact connected account", async () => {
    const {
      user, verifier, authority, authorityProps, verifierContext, verifierRequests,
    } = makeUserWithAccount("notion");

    await expect(user.getVerifier(7, "notion")).resolves.toBe(verifier);
    expect(verifierRequests()).toBe(1);
    expect(verifierContext()).toEqual({authority});
    expect(authorityProps()).toEqual({
      userObjectId: "user-do-id",
      accountId: 7,
      vendorId: "notion",
      subject: "subject-a",
    });
  });

  it("returns null when the account is missing", async () => {
    const { user, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(999, "notion")).resolves.toBeNull();
    expect(verifierRequests()).toBe(0);
  });

  it("throws when the connected account belongs to another vendor", async () => {
    const { user, verifierRequests } = makeUserWithAccount("linear");

    await expect(user.getVerifier(7, "notion")).rejects.toThrow(
        "Invalid account selection for this service.");
    expect(verifierRequests()).toBe(0);
  });
});
