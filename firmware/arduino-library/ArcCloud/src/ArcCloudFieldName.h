// Field-name rule for ArcCloud (no Arduino dependencies, so tests/firmware/field-names.mjs can compile it on a PC).
#pragma once
#include <string.h>

// Longest name the library stores (ArcCloud::Reading/Control keep 32 characters + NUL).
#define ARC_FIELD_NAME_MAX 32

// Same rule as the server (METRIC_KEY in packages/shared: ^[A-Za-z][A-Za-z0-9_]{0,63}$), at most 32 characters:
// a letter first, then letters, digits or '_'. ASCII only, checked explicitly (isalnum depends on the locale).
static inline bool arcIsLetter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }

static inline bool arcValidFieldName(const char *f) {
  if (f == nullptr) return false;
  size_t n = strlen(f);
  if (n == 0 || n > ARC_FIELD_NAME_MAX || !arcIsLetter(f[0])) return false;
  for (size_t i = 1; i < n; i++) {
    char c = f[i];
    if (!(arcIsLetter(c) || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  return true;
}
