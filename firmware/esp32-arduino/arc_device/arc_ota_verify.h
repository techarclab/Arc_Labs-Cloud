// ARC Cloud OTA: signature and version checks. No Arduino dependencies (only mbedTLS + libc), so the
// exact same code is unit-tested on the host in CI (tests/firmware) against signatures produced by
// tools/firmware-sign.mjs and the API. Keep the copies in every sketch folder identical (CI checks it).
#pragma once
#include <ctype.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "mbedtls/base64.h"
#include "mbedtls/md.h"
#include "mbedtls/pk.h"

// mbedtls_md_* has the same signatures in mbedTLS 2.28 (Arduino-ESP32 2.x) and 3.x (Arduino-ESP32 3.x).
static inline int arcSha256(const uint8_t *data, size_t len, uint8_t out[32]) {
  return mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), data, len, out);
}

// Compares MAJOR.MINOR.PATCH numerically ("1.10.0" > "1.9.9"). Anything after PATCH (e.g. "-rc1") is ignored.
// Returns 1, 0 or -1, or -2 if either string does not start with MAJOR.MINOR.PATCH.
static inline int arcCompareVersions(const char *a, const char *b) {
  long va[3] = {0, 0, 0}, vb[3] = {0, 0, 0};
  const char *s[2] = {a, b};
  long *v[2] = {va, vb};
  for (int k = 0; k < 2; k++) {
    const char *p = s[k];
    if (!p) return -2;
    for (int i = 0; i < 3; i++) {
      if (!isdigit((unsigned char)*p)) return -2;
      char *end;
      v[k][i] = strtol(p, &end, 10);
      p = end;
      if (i < 2) {
        if (*p != '.') return -2;
        p++;
      }
    }
  }
  for (int i = 0; i < 3; i++) {
    if (va[i] != vb[i]) return va[i] > vb[i] ? 1 : -1;
  }
  return 0;
}

// Verifies an ECDSA P-256 / SHA-256 signature (DER, base64) over the NUL-terminated `msg` with a PEM public key.
// Returns NULL when valid, otherwise a short reason.
static inline const char *arcVerifySignatureWithKey(const char *msg, const char *signatureB64, const char *publicKeyPem) {
  uint8_t sig[80];  // a DER P-256 signature is at most 72 bytes
  size_t sigLen = 0;
  if (!msg || !signatureB64 || !publicKeyPem) return "missing signature";
  if (mbedtls_base64_decode(sig, sizeof sig, &sigLen, (const unsigned char *)signatureB64, strlen(signatureB64)) != 0 || sigLen < 8) {
    return "bad signature encoding";
  }
  uint8_t hash[32];
  if (arcSha256((const uint8_t *)msg, strlen(msg), hash) != 0) return "SHA-256 unavailable";
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  const char *err = NULL;
  if (mbedtls_pk_parse_public_key(&pk, (const unsigned char *)publicKeyPem, strlen(publicKeyPem) + 1) != 0) {
    err = "OTA public key is not a valid PEM key";
  } else if (mbedtls_pk_get_type(&pk) != MBEDTLS_PK_ECKEY || mbedtls_pk_get_bitlen(&pk) != 256) {
    err = "OTA public key must be ECDSA P-256";
  } else if (mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, sizeof hash, sig, sigLen) != 0) {
    err = "signature check failed: image rejected";
  }
  mbedtls_pk_free(&pk);
  return err;
}
