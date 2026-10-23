// Host build of the firmware's OTA checks (firmware/esp32-arduino/arc_device/arc_ota_verify.h).
//   verify <public.pem> <manifest-file> <signature-b64-file>  → prints OK or the firmware's error, exit 0/1
//   versions                                                 → runs the version-comparison table, exit 0/1
// Built and driven by tests/firmware/run.mjs.
#include <cstdio>
#include <string>
#include "arc_ota_verify.h"

static std::string slurp(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) { perror(path); exit(2); }
  std::string s;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
  fclose(f);
  return s;
}

int main(int argc, char **argv) {
  if (argc == 5 && std::string(argv[1]) == "verify") {
    std::string pem = slurp(argv[2]), manifest = slurp(argv[3]), sig = slurp(argv[4]);
    while (!sig.empty() && (sig.back() == '\n' || sig.back() == '\r')) sig.pop_back();
    const char *err = arcVerifySignatureWithKey(manifest.c_str(), sig.c_str(), pem.c_str());
    puts(err ? err : "OK");
    return err ? 1 : 0;
  }
  if (argc == 2 && std::string(argv[1]) == "versions") {
    struct { const char *a, *b; int want; } cases[] = {
      {"1.0.0", "1.0.0", 0},  {"1.0.1", "1.0.0", 1},   {"1.0.0", "1.0.1", -1}, {"1.10.0", "1.9.9", 1},
      {"2.0.0", "10.0.0", -1}, {"1.2.3-rc1", "1.2.3", 0}, {"1.2", "1.2.0", -2},  {"v1.2.3", "1.2.3", -2},
      {"", "1.0.0", -2},      {"1.0.0", "abc", -2},
    };
    int bad = 0;
    for (auto &c : cases) {
      int got = arcCompareVersions(c.a, c.b);
      if (got != c.want) { printf("FAIL %s vs %s: got %d want %d\n", c.a, c.b, got, c.want); bad++; }
    }
    puts(bad ? "versions: FAIL" : "versions: OK");
    return bad ? 1 : 0;
  }
  fprintf(stderr, "usage: verify <pub.pem> <manifest> <sig.b64> | versions\n");
  return 2;
}
