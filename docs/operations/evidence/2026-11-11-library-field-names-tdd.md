# TDD evidence: ArcCloud library field names (2026-11-11)

Defect: the library accepted `-`, `.` and a leading digit or `_`. The server rule is `^[A-Za-z][A-Za-z0-9_]{0,63}$`, so readings with those names were rejected and the board looked offline.

1. **Refactor, no behaviour change:** the check moved to `src/ArcCloudFieldName.h`, which compiles on a PC.
2. **Test first:** `tests/firmware/field-names.mjs` compiles the header and compares 212 names with the server regex, which it reads from `packages/shared/src/telemetry.ts`.

## Red (before the fix)

```
  ✗ library field names match the server rule /^[A-Za-z][A-Za-z0-9_]{0,63}$/ (max 32 characters), 212 cases
      Expected values to be strictly deep-equal:
      + actual - expected
      
      + [
      +   '"1st": library accepts, should reject',
      +   '"_hidden": library accepts, should reject',
      +   '"temp-c": library accepts, should reject',
      +   '"temp.c": library accepts, should reject',
      +   '"-x": library accepts, should reject',
      +   '".x": library accepts, should reject',
      +   '"-": library accepts, should reject',
      +   '"a-": library accepts, should reject',
      +   '".": library accepts, should reject',
      +   '"a.": library accepts, should reject',
      +   '"0": library accepts, should reject',
      +   '"1": library accepts, should reject',
      +   '"2": library accepts, should reject',
      +   '"3": library accepts, should reject',
      +   '"4": library accepts, should reject',
      +   '"5": library accepts, should reject',
      +   '"6": library accepts, should reject',
      +   '"7": library accepts, should reject',
      +   '"8": library accepts, should reject',
      +   '"9": library accepts, should reject',
      +   '"_": library accepts, should reject'
      + ]
      - []
      
  ✓ a null name is rejected
```

## Green (after the fix)

```
  ✓ library field names match the server rule /^[A-Za-z][A-Za-z0-9_]{0,63}$/ (max 32 characters), 212 cases
  ✓ a null name is rejected
```

CI runs the test in the `firmware-crypto` job. The `firmware-build` job compiles the library examples and the generated sketches for ESP32 and ESP32-S3 against the changed header.
