# ZAP 40018 reproduction (2026-11-11)

A local API (same build) and a non-platform user. `PATCH /api/v1/organizations/id/plan` with `{"plan":"pro","maxApiKeys":<payload>}`:

```
true : 400 {"message":"Validation failed (uuid is expected)","error":"Bad Request","statusCode":400}
false: 400 {"message":"Validation failed (uuid is expected)","error":"Bad Request","statusCode":400}
orig : 400 {"message":"Validation failed (uuid is expected)","error":"Bad Request","statusCode":400}
identical: true
320 requests in a burst, statuses: { '400': 297, '429': 23 }
```
