import assert from "node:assert/strict";
import test from "node:test";
import { redirectToLogin, resetLoginRedirectForTests } from "./loginRedirect";

type LocationMock = {
  pathname: string;
  replace: (url: string) => void;
};

function installLocationMock(pathname: string): {
  location: LocationMock;
  replaces: string[];
} {
  const replaces: string[] = [];
  const location: LocationMock = {
    pathname,
    replace(url: string) {
      replaces.push(url);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
    writable: true,
  });
  return { location, replaces };
}

test("redirectToLogin replaces with /login once", async () => {
  resetLoginRedirectForTests();
  const { replaces } = installLocationMock("/settings");

  redirectToLogin();
  redirectToLogin();

  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.deepEqual(replaces, ["/login"]);
});

test("redirectToLogin is a no-op on /login", async () => {
  resetLoginRedirectForTests();
  const { replaces } = installLocationMock("/login");

  redirectToLogin();
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.deepEqual(replaces, []);
});
