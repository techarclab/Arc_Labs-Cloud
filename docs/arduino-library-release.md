# Publishing the ArcCloud Arduino library

The library is developed in this repository (`firmware/arduino-library/ArcCloud`). The Arduino Library Manager can
only install a library that sits at the root of its own public Git repository with tagged releases, so
`.github/workflows/arccloud-library.yml` copies the folder to that repository and tags each new version.

## One-time setup

1. **Library repository.** Create a public repository (e.g. `techarclab/arciotcloud`) and tick *Add a README*,
   so it has one commit. The workflow replaces the README with the library's on the first release.
2. **Token.** GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*:
   - Repository access: *Only select repositories* → the library repository.
   - Permissions: *Contents: Read and write*. Nothing else.
   - Pick an expiry (e.g. 1 year) and note the date: releases stop when it expires.
3. **Secret and variable** in this repository (Settings → Secrets and variables → Actions):
   - secret `ARCCLOUD_IOT_LIBRARY_TOKEN` = the token;
   - variable `ARCCLOUD_IOT_REPO` = `techarclab/arciotcloud`.
4. **First release.** Actions → *ArcCloud library release* → *Run workflow* (on `main`). It lints the library,
   copies it and tags the version from `library.properties` (e.g. `1.1.0`).
5. **Register with Arduino (once).** Fork https://github.com/arduino/library-registry, add the line
   `https://github.com/techarclab/arciotcloud` to the end of `repositories.txt`, open a pull request. A bot checks the
   library and merges it if it passes; it can take a day to appear in the IDE's Library Manager.

## Every release after that

1. Change the library and bump `version=` in `library.properties` (semantic versioning), add a line under
   *Changes* in its README.
2. Merge to `main`. The workflow publishes and tags the new version; the Library Manager picks it up by itself.

A version that is already tagged is never re-published: bump the version to release again. Don't edit the library
repository by hand; the next release overwrites it.

Users then install it from the Arduino IDE: *Tools → Manage Libraries…* → search **ArcCloud** → *Install*
(the IDE offers to install PubSubClient and ArduinoJson with it). The console's *Download the library (.zip)* link
keeps working for anyone who prefers the zip.
