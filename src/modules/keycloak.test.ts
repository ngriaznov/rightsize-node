import { describe, it, assert } from "../../test/harness.js";
import { KeycloakContainer } from "./keycloak.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("KeycloakContainer", () => {
  it("exposes HTTP (8080) and management (9000) ports, runs start-dev, and sets the 26.x bootstrap-admin env", async () => {
    const backend = new FakeModuleBackend();
    const keycloak = new KeycloakContainer().withBackend(backend).waitingFor(instantReadyWait());
    await keycloak.start();
    try {
      assert.equal(backend.lastSpec?.image, "quay.io/keycloak/keycloak:26.0");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [8080, 9000]);
      assert.deepEqual(backend.lastSpec?.command, ["start-dev"]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("KC_BOOTSTRAP_ADMIN_USERNAME"), "admin");
      assert.equal(env.get("KC_BOOTSTRAP_ADMIN_PASSWORD"), "admin");
      assert.equal(env.get("KC_HEALTH_ENABLED"), "true");
    } finally {
      await keycloak.stop();
    }
  });

  it("defaults to a 1024MB memory limit", async () => {
    const backend = new FakeModuleBackend();
    const keycloak = new KeycloakContainer().withBackend(backend).waitingFor(instantReadyWait());
    await keycloak.start();
    try {
      assert.equal(backend.lastSpec?.memoryLimitMb, 1024);
    } finally {
      await keycloak.stop();
    }
  });

  it("withAdminUsername/withAdminPassword override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const keycloak = new KeycloakContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withAdminUsername("root")
      .withAdminPassword("s3cret");
    await keycloak.start();
    try {
      assert.equal(keycloak.adminUsername, "root");
      assert.equal(keycloak.adminPassword, "s3cret");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("KC_BOOTSTRAP_ADMIN_USERNAME"), "root");
      assert.equal(env.get("KC_BOOTSTRAP_ADMIN_PASSWORD"), "s3cret");
    } finally {
      await keycloak.stop();
    }
  });

  it("builds authServerUrl from host and the mapped HTTP port", async () => {
    const backend = new FakeModuleBackend();
    const keycloak = new KeycloakContainer().withBackend(backend).waitingFor(instantReadyWait());
    await keycloak.start();
    try {
      const mapped = keycloak.getMappedPort(8080);
      assert.equal(keycloak.authServerUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await keycloak.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const keycloak = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.8").withBackend(backend).waitingFor(instantReadyWait());
    await keycloak.start();
    try {
      assert.equal(backend.lastSpec?.image, "quay.io/keycloak/keycloak:26.0.8");
    } finally {
      await keycloak.stop();
    }
  });
});
