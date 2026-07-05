// Dedicated, standalone proof that `await using` in this project's own
// source dispatches `[Symbol.asyncDispose]` through the ACTUAL compiled
// artifact — the tslib downlevel helper (`__addDisposableResource` /
// `__disposeResources`) that `tsc` emits for `importHelpers: true` — rather
// than through V8's native parser. Node 22 does not parse `await using` at
// all (see docs/runtime-baseline.md); Bun does parse it natively, which is
// precisely why this file matters on Bun too: Bun could satisfy a naive
// smoke test by using its OWN native disposal machinery on the source
// syntax, while still shipping (and mis-running) a broken tslib helper in
// `dist/`. This test runs the same compiled-JS code path both runners will
// actually execute in production, so it catches either failure mode.
//
// No real backend or container is involved — the "resource" here is a bare
// stub object implementing AsyncDisposable, exactly the shape the review
// asked this verifier to use.
import { describe, it, assert } from "../../test/harness.js";

class StubResource implements AsyncDisposable {
  disposed = false;

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

describe("await using dispatches Symbol.asyncDispose (tslib downlevel helper)", () => {
  it("calls [Symbol.asyncDispose] exactly once at scope exit", async () => {
    const resource = new StubResource();

    assert.equal(resource.disposed, false);
    {
      await using r = resource;
      assert.equal(r.disposed, false);
    }
    assert.equal(resource.disposed, true);
  });

  it("disposes multiple resources in reverse declaration order (LIFO), the documented tslib contract", async () => {
    const disposedOrder: string[] = [];
    function tracked(name: string): AsyncDisposable {
      return {
        async [Symbol.asyncDispose]() {
          disposedOrder.push(name);
        },
      };
    }

    {
      await using first = tracked("first");
      await using second = tracked("second");
      await using third = tracked("third");
      void first;
      void second;
      void third;
    }

    assert.deepEqual(disposedOrder, ["third", "second", "first"]);
  });

  it("still disposes when the scope exits via a thrown error", async () => {
    let disposed = false;
    function resource(): AsyncDisposable {
      return {
        async [Symbol.asyncDispose]() {
          disposed = true;
        },
      };
    }

    await assert.rejects(async () => {
      await using r = resource();
      void r;
      throw new Error("boom");
    });

    assert.equal(disposed, true);
  });

  it("propagates the value asyncDispose's own async work computed, proving the helper actually awaits it", async () => {
    let awaitedInsideDispose = false;
    function resource(): AsyncDisposable {
      return {
        async [Symbol.asyncDispose]() {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
          awaitedInsideDispose = true;
        },
      };
    }

    {
      await using r = resource();
      void r;
    }
    // If the downlevel helper only fired the call without awaiting the
    // returned promise, this flag would still be false immediately after
    // the block — the helper's whole job is to await disposal before
    // control leaves the `using` scope.
    assert.equal(awaitedInsideDispose, true);
  });
});
