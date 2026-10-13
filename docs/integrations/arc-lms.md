# ARC LMS / ARC Academy integration

ARC Cloud stays a separate service. ARC LMS never reads the database; it calls the API with narrow, time-limited access.

```
ARC LMS server ──client_credentials──▶ /api/v1/oauth/token (service account, read-only)
ARC LMS server ──▶ POST /api/v1/lms/links/{linkId}/learner-tokens {learnerRef, minutes}
                 ◀── {accessToken, expiresIn, viewerUrl}
Learner's browser ──▶ viewerUrl (read-only lab view)  or  the API with the learner token
```

## Set up (ARC Cloud admin)
1. *Integrations → Service accounts* → **New service account**, role *Viewer*. Copy the client ID and secret into the LMS server's configuration (never into the browser).
2. *Integrations → ARC LMS* → **Link a course/lab**: choose the channel and, optionally, specific devices; set the LMS reference (e.g. `iot-101/lab-3`) and the maximum learner session length.

## LMS server calls
```http
POST /api/v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<id>&client_secret=<secret>
```
→ `{ "access_token": "...", "expires_in": 900 }`

```http
POST /api/v1/lms/links/<linkId>/learner-tokens
Authorization: Bearer <access_token>
Content-Type: application/json

{ "learnerRef": "student-42", "minutes": 60 }
```
→ `{ "accessToken": "...", "expiresIn": 3600, "viewerUrl": "https://<console>/lab#..." }`

Open `viewerUrl` for the learner (link or iframe). The learner can only **read** the linked devices' readings and state; no controls, commands, credentials or other devices. Access ends when the token expires or the link is revoked. Every learner token is recorded in the audit log (`lms.learner_token`, with the learner reference).

Set `CONSOLE_URL` on the API so `viewerUrl` is filled in.
