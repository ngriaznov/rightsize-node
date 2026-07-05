import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { KeycloakContainer } from "./keycloak.js";

function getJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10_000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
  });
}

describe("Keycloak module", () => {
  itIntegration("OIDC discovery on the master realm exposes an issuer field", async () => {
    const keycloak = await KeycloakContainer.start();
    try {
      const res = await getJson(`${keycloak.authServerUrl}/realms/master/.well-known/openid-configuration`);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body) as { issuer?: string };
      assert.ok(parsed.issuer !== undefined, "expected an issuer field in the discovery document");
      assert.match(parsed.issuer ?? "", /\/realms\/master$/);
    } finally {
      await keycloak.stop();
    }
  });
});
