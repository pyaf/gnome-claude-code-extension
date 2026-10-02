# Claude Code Usage (GNOME Shell extension)

A tiny, unobtrusive GNOME Shell extension that shows how much of your Claude
Code subscription you have used, right in the top panel.

```
[Claude mark]  5h 38% · 7d 74%
```

The Claude mark is followed by two windows:

- **`5h`** — the rolling 5-hour session limit, as **% used**
- **`7d`** — the weekly limit, as **% used**

The label is dimmed, uses tabular (monospaced) digits and only picks up a
warning colour when usage gets high, so it stays out of the way.

Click it for a small menu with usage bars, reset countdowns and a manual
**Refresh now** action. If you are signed out it shows `signed out` next to the
mark.

## Requirements

- GNOME Shell 45, 46 or 47
- Claude Code installed and logged in (`~/.claude/.credentials.json` present)
- `glib-networking` (present by default on any GNOME install)

## Install

```sh
git clone https://github.com/pyaf/gnome-claude-code-extension.git ~/CODE/claude-code-usage
cd ~/CODE/claude-code-usage
./install.sh          # symlinks the repo into ~/.local/share/gnome-shell/extensions
gnome-extensions enable claude-code-usage@rishabh
```

If the extension does not show up, restart the shell:

- **X11:** press `Alt`+`F2`, type `r`, press `Enter`
- **Wayland:** log out and back in

To uninstall:

```sh
gnome-extensions disable claude-code-usage@rishabh
rm -rf ~/.local/share/gnome-shell/extensions/claude-code-usage@rishabh
```

## How it works

Every 60 seconds the extension:

1. Reads your existing Claude Code credentials from
   `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`).
2. If the access token is about to expire, refreshes it through Anthropic's
   OAuth token endpoint and **writes the rotated token back** to the same file,
   so Claude Code stays logged in.
3. Calls `https://api.anthropic.com/api/oauth/usage` and renders the
   `five_hour` and `seven_day` utilization as percentages used.

Polling runs every 2 minutes. Opening the menu (at most once a minute) or
clicking **Refresh now** forces a fetch.

### Robustness

- **Concurrent refresh:** the credentials file is re-read immediately before it
  is written. If Claude Code refreshed the token in the meantime, the extension
  backs off and leaves the file untouched.
- **Expired / revoked login:** a `401` or `invalid_grant` switches the panel to
  `signed out`.
- **Rate limits:** Anthropic's usage endpoint returns `429` easily. On a `429`
  the extension backs off (2 minutes, doubling up to 30) instead of retrying
  every poll, and keeps showing the last successful reading, dimmed.
- **Cached values:** the last successful reading is stored in
  `~/.cache/claude-code-usage/last.json` and restored on start, so a fresh
  login or a rate-limited start still shows your most recent numbers.
- **File permissions:** the credentials file is rewritten `0600`.

## Privacy and security

- The extension talks only to `api.anthropic.com` and `platform.claude.com`
  over HTTPS.
- Your tokens are read from disk and sent to Anthropic only, exactly as the
  Claude CLI does. Nothing is logged or sent anywhere else.
- No telemetry.

## Notes

- This is an **unofficial** extension. It relies on an undocumented endpoint
  that may change without notice, and on the public Claude Code OAuth client id.
- The request carries a `claude-cli/<version>` user-agent because the token
  endpoint is behind Cloudflare and rejects other clients.
- If the endpoint changes, only `USAGE_URL` / `TOKEN_URL` / `CLIENT_ID` in
  `extension.js` need updating.
- The usage endpoint is known to return `429` with `retry-after: 0` for long
  stretches (anthropics/claude-code issues #30930 and #31021). When that
  happens the panel dims and the menu says "rate limited"; that is the metadata
  API, not your quota. Anthropic's own `/usage` command fails the same way. The
  extension recovers automatically once the endpoint answers again.

## Development

The extension is a single `extension.js` plus `stylesheet.css`. Useful commands:

```sh
make install    # symlink for development
make enable
make pack       # build claude-code-usage@rishabh.shell-extension.zip
```

Relevant constants live at the top of `extension.js`:

| Constant         | Meaning                                  |
| ---------------- | ---------------------------------------- |
| `POLL_SECONDS`   | Refresh interval (default `60`)          |
| `EXPIRY_BUFFER_MS` | Refresh token this long before expiry  |
| `BAR_WIDTH`      | Menu bar width in pixels                 |

## Releasing / renaming

`metadata.json` is the single source of truth for the UUID. If you fork this and
want your own UUID, change `"uuid"` there and re-run `./install.sh`.

## Icon and trademark

`icons/claude.svg` is the Claude Code logo, included only to identify the
service in the panel. It is a trademark of Anthropic, PBC, and this project is
unofficial and not affiliated with or endorsed by Anthropic.

## License

MIT — see [LICENSE](LICENSE).
