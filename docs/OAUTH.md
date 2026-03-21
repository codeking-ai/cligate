# OAuth Implementation

This proxy uses **OAuth 2.0 with PKCE** for secure authentication with ChatGPT.

## Quick Start

### Desktop (Browser)
```bash
proxypool-hub accounts add
```

### Headless/VM (No Browser)
```bash
proxypool-hub accounts add --no-browser
```

## Headless/VM Workflow

When running on a server without a browser (VM, Docker, SSH):

1. Run the command with `--no-browser`:
   ```bash
   proxypool-hub accounts add --no-browser
   ```

2. It prints a URL like:
   ```
   https://auth.openai.com/oauth/authorize?response_type=code&...
   ```

3. Copy the URL and open it in a browser on **any other device** (your laptop, phone, etc.)

4. Complete the ChatGPT login

5. After successful login, you'll be redirected to a localhost URL that looks like:
   ```
   http://localhost:1455/auth/callback?code=ABC123...
   ```

6. Copy that entire URL (or just the `code` parameter) and paste it back in the terminal

7. The proxy exchanges the code for tokens and saves your account

## OAuth Config

- **Client ID**: `app_EMoamEEZ73f0CkXaXp7hrann`
- **Auth URL**: `https://auth.openai.com/oauth/authorize`
- **Token URL**: `https://auth.openai.com/oauth/token`
- **Callback Port**: `1455`

## Features

- **PKCE**: Secure code exchange with SHA256 challenge
- **Auto-Refresh**: Tokens refresh automatically before expiry
- **Multi-Account**: Uses `prompt=login` to force account selection
- **Headless Support**: Works on servers without browsers

## Managing Accounts

```bash
# List accounts
proxypool-hub accounts list

# Add account (browser)
proxypool-hub accounts add

# Add account (headless)
proxypool-hub accounts add --no-browser

# Clear all accounts
proxypool-hub accounts clear
```

## Troubleshooting

### "Port already in use"
The `--no-browser` mode works independently of the server - you can add accounts even while the proxy is running.

### "Invalid state" error
This happens if you use a code from an old session. Generate a fresh URL and try again.

### Same account keeps getting selected
Clear cookies at `auth.openai.com` or use a private/incognito window.
