# Account Management

## Storage Structure

### Main Registry

**Location:** `~/.proxypool-hub/accounts.json`

```json
{
  "accounts": [
    {
      "email": "user@gmail.com",
      "accountId": "d41e9636-16d8-42be-91da-7ea8773bfb7e",
      "planType": "plus",
      "accessToken": "eyJhbGciOiJSUzI1NiIs...",
      "refreshToken": "rt_WpTMn1...",
      "idToken": "eyJhbGciOiJSUzI1NiIs...",
      "expiresAt": 1770886178000,
      "addedAt": "2026-02-13T04:00:00.000Z",
      "lastUsed": "2026-02-13T04:30:00.000Z",
      "quota": {
        "usage": {...},
        "account": {...},
        "lastChecked": "2026-02-14T10:00:00.000Z"
      }
    }
  ],
  "activeAccount": "user@gmail.com",
  "version": 1
}
```

### Per-Account Tokens

**Location:** `~/.proxypool-hub/accounts/<email>/auth.json`

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-02-14T10:00:00.000Z"
}
```

## Operations

### Add Account (OAuth)

```bash
curl -X POST http://localhost:8081/accounts/add

# Returns OAuth URL to open in browser
```

### Import from Codex App

```bash
curl -X POST http://localhost:8081/accounts/import

# Imports from ~/.codex/auth.json
```

### List Accounts

```bash
curl http://localhost:8081/accounts

# Response
{
  "accounts": [
    {
      "email": "user@gmail.com",
      "accountId": "...",
      "planType": "plus",
      "addedAt": "...",
      "lastUsed": "...",
      "isActive": true,
      "tokenExpired": false,
      "quota": {...}
    }
  ],
  "activeAccount": "user@gmail.com",
  "total": 1
}
```

### Switch Active Account

```bash
curl -X POST http://localhost:8081/accounts/switch \
  -H "Content-Type: application/json" \
  -d '{"email":"other@gmail.com"}'
```

Switching:
1. Updates `activeAccount` in `accounts.json`
2. Updates auth file for the account
3. Next API calls use new account's credentials

### Remove Account

```bash
curl -X DELETE http://localhost:8081/accounts/user@gmail.com
```

Removes:
- Account from registry
- Per-account token directory

### Refresh Tokens

```bash
# Active account
curl -X POST http://localhost:8081/accounts/refresh

# Specific account
curl -X POST http://localhost:8081/accounts/user@gmail.com/refresh

# All accounts
curl -X POST http://localhost:8081/accounts/refresh/all
```

## Token Lifecycle

### Expiration

- Access tokens expire in ~1 hour (3600 seconds)
- Refresh tokens are long-lived (weeks/months)

### Auto-Refresh

- Background refresh every **55 minutes**
- Startup refresh 2 seconds after server start
- Proactive refresh 5 minutes before expiry

### Token Validation

Before each API call:
1. Check if token is expired or expiring within 5 minutes
2. If yes, refresh using refresh token
3. Use new access token for the call

## Quota Tracking

### Fetch Quota

```bash
curl http://localhost:8081/accounts/quota

# Response
{
  "success": true,
  "email": "user@gmail.com",
  "quota": {
    "usage": {
      "totalTokenUsage": 15,
      "limit": 100,
      "remaining": 85,
      "percentage": 15,
      "resetAt": "..."
    },
    "account": {...}
  },
  "cached": false
}
```

### Web UI Quota Display Rules

- The Accounts table displays **remaining quota** as a percentage.
- Remaining percentage is normalized to `0-100` to avoid broken UI values.
- If `limitReached=true` or `allowed=false`, UI shows quota as exhausted even when percentage data is missing.
- If usage data is unavailable, UI shows `-` instead of rendering a broken bar.
- Reset window is shown using `usage.resetAt` (with fallback to `usage.raw.rate_limit.primary_window.reset_at`).
- UI also shows a relative countdown (e.g. `Resets in 6d 13h`) when reset data is available.

### Refresh All Quotas

```bash
curl http://localhost:8081/accounts/quota/all
```

## Account Persistence

On server startup:
1. `ensureAccountsPersist()` loads accounts
2. Restores active account's auth
3. Starts auto-refresh timer

## Security

- Tokens stored locally in `~/.proxypool-hub/`
- Directory permissions: user read/write only
- Never logged or exposed in API responses
- Per-account isolation via separate directories
