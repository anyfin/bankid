// Throwaway certificates for testing the default transport against a local
// TLS server: a CA, a server certificate for localhost signed by it, a client
// certificate signed by it, and a client certificate from an unrelated CA.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsFixtures {
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** The client certificate and key as PKCS#12, protected by `pfxPassphrase`. */
  clientPfx: Buffer;
  pfxPassphrase: string;
  /** A client certificate the server does not trust. */
  strangerCert: string;
  strangerKey: string;
}

const config = `
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
[client]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
`;

export const createTlsFixtures = (): TlsFixtures => {
  const dir = mkdtempSync(join(tmpdir(), "bankid-tls-"));
  const path = (name: string) => join(dir, name);
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  try {
    writeFileSync(path("openssl.cnf"), config);
    const selfSigned = (name: string, cn: string) =>
      openssl(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${cn}`,
        "-config",
        "openssl.cnf",
        "-extensions",
        "ca",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.crt`,
      );
    const issued = (name: string, cn: string, ca: string, profile: string) => {
      openssl(
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        `/CN=${cn}`,
        "-config",
        "openssl.cnf",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
      );
      openssl(
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        `${ca}.crt`,
        "-CAkey",
        `${ca}.key`,
        "-set_serial",
        String(Date.now()),
        "-days",
        "1",
        "-extfile",
        "openssl.cnf",
        "-extensions",
        profile,
        "-out",
        `${name}.crt`,
      );
    };

    selfSigned("ca", "Throwaway Test CA");
    issued("server", "localhost", "ca", "server");
    issued("client", "Throwaway Relying Party", "ca", "client");
    selfSigned("stranger-ca", "Unrelated CA");
    issued("stranger", "Stranger", "stranger-ca", "client");

    const pfxPassphrase = "fixture-pfx-passphrase";
    openssl(
      "pkcs12",
      "-export",
      "-inkey",
      "client.key",
      "-in",
      "client.crt",
      "-keypbe",
      "AES-256-CBC",
      "-certpbe",
      "AES-256-CBC",
      "-macalg",
      "sha256",
      "-passout",
      `pass:${pfxPassphrase}`,
      "-out",
      "client.p12",
    );

    const text = (name: string) => readFileSync(path(name), "utf8");
    return {
      caCert: text("ca.crt"),
      serverCert: text("server.crt"),
      serverKey: text("server.key"),
      clientCert: text("client.crt"),
      clientKey: text("client.key"),
      clientPfx: readFileSync(path("client.p12")),
      pfxPassphrase,
      strangerCert: text("stranger.crt"),
      strangerKey: text("stranger.key"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
