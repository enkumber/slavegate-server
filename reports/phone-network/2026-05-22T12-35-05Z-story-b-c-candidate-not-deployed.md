# Story B+C Candidate Deploy Blocker

- capturedAt: 2026-05-22T12:35:05Z
- expected appVersion: 3.9.23
- expected server commit: f487e8af82a1d658c1b98a1855f14e80a0e5ba36
- live appVersion: 3.9.22
- live buildCommit: fee20898441aa3bfb78b4a21bf02ceb4689c26c5
- baseUrl: http://enkzoned.go.ro:3000
- auth: redacted API key from persistent OpenClaw credential store

## Health

```json
{"ok":true,"data":{"status":"healthy","ts":"2026-05-22T12:34:55.509Z","appVersion":"3.9.22","buildCommit":"fee20898441aa3bfb78b4a21bf02ceb4689c26c5"}}
```

## Edge Status

```json
{"ok":true,"data":{"totalOnline":2,"edgeCapable":2,"legacyOnly":0,"executionMode":"edge","devices":[{"deviceId":"22cfa4b5-f35b-4949-982f-8bb4a15b059d","shortDeviceId":"22cfa4b5","agentVersion":"4.0.19","edgeCapable":true},{"deviceId":"d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd","shortDeviceId":"d35b34cb","agentVersion":"4.0.22","edgeCapable":true}]}}
```

## Agency Route Probe

Request:

```http
POST /api/agency/workflow-runs
content-type: application/json
x-api-key: <redacted>

{}
```

Response: HTTP 404

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot POST /api/agency/workflow-runs</pre>
</body>
</html>
```

## Blocker

The candidate package containing `f487e8a` is not deployed to live yet. The live server still predates the Story C agency workflow-runs route, so the required Story B+C evidence path cannot start. No generated workflow execution, Reddit action, or Umbrel bump was performed.
