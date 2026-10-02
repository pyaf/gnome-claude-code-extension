// Claude Code Usage — GNOME Shell extension
// Shows Claude Code rate limit usage (5-hour session + weekly) in the top
// panel, using the credentials of your locally authenticated Claude Code.
//
// This is an unofficial extension and uses an undocumented Anthropic endpoint.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// How often the limits are re-fetched, in seconds.
const POLL_SECONDS = 120;

// Refresh the access token if it expires within this window.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Minimum time between automatic fetches, so opening the menu repeatedly
// cannot hammer the usage endpoint (which rate-limits aggressively).
const AUTO_REFRESH_MIN_MS = 60 * 1000;

// Even a forced fetch waits this long, so spam-clicking Refresh does nothing.
const FORCE_MIN_MS = 15 * 1000;

// Backoff applied after the usage endpoint returns 429. Anthropic's usage API
// rate-limits easily and can stay limited for a long time, so back off
// exponentially instead of retrying on every poll.
const RATE_LIMIT_BACKOFF_MS = 2 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 30 * 60 * 1000;

// Height and minimum width of the usage bars in the popup menu, in pixels.
const BAR_HEIGHT = 6;
const BAR_MIN_WIDTH = 160;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// The Cloudflare front in front of the token endpoint rejects requests that
// do not carry the Claude CLI user-agent, so we mirror it. Only the
// "claude-cli/<version> (...)" shape matters, not the exact version.
const USER_AGENT = 'claude-cli/2.1.285 (external, cli)';

const CONFIG_DIR = GLib.getenv('CLAUDE_CONFIG_DIR') ??
    GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
const CREDENTIALS_PATH = GLib.build_filenamev([CONFIG_DIR, '.credentials.json']);

// Last successful readings, so a rate-limited or offline start still shows
// the most recent known values instead of an error.
const CACHE_PATH = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'claude-code-usage', 'last.json']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves a Soup request to a GLib.Bytes, rejecting on transport errors. */
function sendRequest(session, message) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (sess, res) => {
                try {
                    resolve(sess.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function errorWithKind(message, kind) {
    const error = new Error(message);
    error.kind = kind;
    return error;
}

function levelFor(used, severity) {
    if (severity === 'critical')
        return 'critical';
    if (severity === 'warning')
        return 'warn';
    if (used >= 90)
        return 'critical';
    if (used >= 75)
        return 'warn';
    return 'normal';
}

function formatDuration(ms) {
    if (!(ms > 0))
        return 'now';

    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m`;
    return '<1m';
}

function pad2(n) {
    return `${n}`.padStart(2, '0');
}

function formatClock(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function clampPercent(value) {
    return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// A bar drawn with Cairo. The fill is painted as a fraction of the surface,
// so it is always exact regardless of how the menu lays out or scales.
// ---------------------------------------------------------------------------

const UsageBar = GObject.registerClass(
class UsageBar extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'claude-usage-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._used = 0;
        this._level = 'normal';
        this.connect('repaint', () => this._draw());
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this.queue_repaint();
        });
    }

    setUsage(used, level) {
        this._used = used;
        this._level = level;
        this.queue_repaint();
    }

    vfunc_get_preferred_height(_forWidth) {
        return [BAR_HEIGHT, BAR_HEIGHT];
    }

    vfunc_get_preferred_width(_forHeight) {
        return [BAR_MIN_WIDTH, BAR_MIN_WIDTH];
    }

    _draw() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        if (width > 0 && height > 0) {
            const radius = height / 2;

            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.35);
            this._roundRect(cr, 0, 0, width, height, radius);
            cr.fill();

            const fillWidth = Math.max(0, Math.min(width, width * this._used / 100));
            if (fillWidth > 0) {
                const [r, g, b] = this._color();
                cr.setSourceRGBA(r, g, b, 1);
                this._roundRect(cr, 0, 0, fillWidth, height, radius);
                cr.fill();
            }
        }

        cr.$dispose();
    }

    _roundRect(cr, x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }

    _color() {
        if (this._level === 'critical')
            return [0.878, 0.106, 0.141];
        if (this._level === 'warn')
            return [0.961, 0.741, 0.067];
        return [0.208, 0.518, 0.894];
    }
});

// ---------------------------------------------------------------------------
// One row in the popup menu: "Session (5h)   42% used", a bar and a reset line.
// ---------------------------------------------------------------------------

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false, can_focus: false});

        this._box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-usage-row',
        });
        this.add_child(this._box);

        const top = new St.BoxLayout({x_expand: true});
        this._title = new St.Label({
            text: title,
            x_expand: true,
            style_class: 'claude-usage-title',
        });
        this._value = new St.Label({
            text: '—',
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-usage-value',
        });
        top.add_child(this._title);
        top.add_child(this._value);
        this._box.add_child(top);

        this._bar = new UsageBar();
        this._box.add_child(this._bar);

        this._reset = new St.Label({
            text: '',
            style_class: 'claude-usage-reset',
        });
        this._box.add_child(this._reset);

        this.setData(null);
    }

    setData(data) {
        if (!data) {
            this._value.text = '—';
            this._bar.setUsage(0, 'normal');
            this._reset.text = '';
            return;
        }

        this._value.text = `${Math.round(data.used)}% used`;
        this._bar.setUsage(data.used, data.level);

        if (data.resetAt) {
            const resetTime = new Date(data.resetAt).getTime();
            this._reset.text = `resets in ${formatDuration(resetTime - Date.now())}`;
        } else {
            this._reset.text = '';
        }
    }
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default class ClaudeCodeUsageExtension extends Extension {
    enable() {
        this._destroyed = false;
        this._refreshing = false;
        this._state = 'loading';
        this._data = null;
        this._error = null;
        this._errorKind = null;
        this._plan = null;
        this._lastUpdated = null;
        this._lastAttempt = 0;
        this._stale = false;
        this._backoffMs = 0;
        this._notBefore = 0;

        this._session = new Soup.Session();
        this._session.timeout = 30;

        this._restoreCache();

        this._buildUi();
        this._render();

        this._refresh();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        this._destroyed = true;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        this._data = null;
    }

    // -- UI -----------------------------------------------------------------

    _buildUi() {
        this._button = new PanelMenu.Button(0.5, 'Claude Code Usage', false);

        this._panelBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-box',
        });

        const iconPath =
            this.dir.get_child('icons').get_child('claude.svg').get_path();
        if (Gio.File.new_for_path(iconPath).query_exists(null)) {
            this._panelIcon = new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'claude-usage-icon',
            });
            this._panelBox.add_child(this._panelIcon);
        }

        this._panelLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this._panelBox.add_child(this._panelLabel);

        this._button.add_child(this._panelBox);

        const menu = this._button.menu;

        this._headerItem = new PopupMenu.PopupMenuItem('Claude Code', {
            reactive: false,
            can_focus: false,
        });
        this._headerItem.label.add_style_class_name('claude-usage-header');
        menu.addMenuItem(this._headerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sessionItem = new UsageRow('Session (5h)');
        this._weeklyItem = new UsageRow('Weekly (7d)');
        menu.addMenuItem(this._sessionItem);
        menu.addMenuItem(this._weeklyItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('claude-usage-status');
        menu.addMenuItem(this._statusItem);

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshItem.connect('activate', () => this._refresh(true));
        menu.addMenuItem(this._refreshItem);

        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._refresh(true);
        });

        Main.panel.addToStatusArea('claude-code-usage', this._button);
    }

    _render() {
        if (this._destroyed)
            return;
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        const label = this._panelLabel;
        const box = this._panelBox;

        box.remove_style_class_name('claude-usage-muted');
        label.remove_style_class_name('claude-usage-warn');
        label.remove_style_class_name('claude-usage-critical');

        if (this._state === 'signed-out') {
            label.text = 'signed out';
            box.add_style_class_name('claude-usage-muted');
        } else if (this._data) {
            const parts = [];
            let level = 'normal';

            for (const [key, name] of [['session', '5h'], ['weekly', '7d']]) {
                const entry = this._data[key];
                if (!entry)
                    continue;
                parts.push(`${name} ${Math.round(entry.used)}%`);
                if (entry.level === 'critical')
                    level = 'critical';
                else if (entry.level === 'warn' && level !== 'critical')
                    level = 'warn';
            }

            label.text = parts.length ? parts.join(' · ') : '—';

            // Dim the values when they are from the cache (failed refresh).
            if (this._stale)
                box.add_style_class_name('claude-usage-muted');

            if (level === 'critical')
                label.add_style_class_name('claude-usage-critical');
            else if (level === 'warn')
                label.add_style_class_name('claude-usage-warn');
        } else if (this._state === 'error') {
            label.text = 'n/a';
            box.add_style_class_name('claude-usage-muted');
        } else {
            label.text = '…';
            box.add_style_class_name('claude-usage-muted');
        }
    }

    _renderMenu() {
        this._headerItem.label.text =
            this._plan ? `Claude Code · ${this._plan}` : 'Claude Code';

        if (this._state === 'signed-out') {
            this._sessionItem.setData(null);
            this._weeklyItem.setData(null);
            this._statusItem.label.text =
                'Not signed in — run `claude` to authenticate';
            return;
        }

        this._sessionItem.setData(this._data?.session ?? null);
        this._weeklyItem.setData(this._data?.weekly ?? null);

        if (this._error && this._stale && this._lastUpdated) {
            this._statusItem.label.text = this._errorKind === 'rate'
                ? `Anthropic usage API rate limited · showing values from ${formatClock(this._lastUpdated)}`
                : `⚠ ${this._error} · showing values from ${formatClock(this._lastUpdated)}`;
        } else if (this._error) {
            this._statusItem.label.text = this._errorKind === 'rate'
                ? 'Anthropic usage API rate limited (not your quota)'
                : `⚠ ${this._error}`;
        } else if (this._lastUpdated) {
            this._statusItem.label.text = `Updated ${formatClock(this._lastUpdated)}`;
        } else {
            this._statusItem.label.text = 'Loading…';
        }
    }

    // -- Data ---------------------------------------------------------------

    async _refresh(force = false) {
        if (this._refreshing || this._destroyed)
            return;

        const minGap = force ? FORCE_MIN_MS : AUTO_REFRESH_MIN_MS;
        if (this._lastAttempt && Date.now() - this._lastAttempt < minGap)
            return;
        if (!force && Date.now() < this._notBefore)
            return;

        this._lastAttempt = Date.now();
        this._refreshing = true;
        try {
            const oauth = this._readCredentials();
            if (!oauth?.accessToken) {
                this._setSignedOut();
                return;
            }

            this._plan = this._prettyPlan(oauth.subscriptionType);

            let token = oauth.accessToken;
            if (oauth.expiresAt &&
                oauth.expiresAt - Date.now() < EXPIRY_BUFFER_MS) {
                token = await this._refreshAccessToken(oauth);
                if (!token) {
                    this._setSignedOut();
                    return;
                }
            }

            const usage = await this._fetchUsage(token);
            if (this._destroyed)
                return;

            this._data = this._parseUsage(usage);
            this._lastUpdated = new Date();
            this._error = null;
            this._errorKind = null;
            this._state = 'ok';
            this._stale = false;
            this._backoffMs = 0;
            this._notBefore = 0;
            this._writeCache();
            this._render();
        } catch (error) {
            if (this._destroyed)
                return;

            if (error.kind === 'auth') {
                this._setSignedOut();
                return;
            }

            // Keep showing the last known values on transient failures.
            this._errorKind = error.kind ?? null;

            if (error.kind === 'rate') {
                this._backoffMs = this._backoffMs
                    ? Math.min(this._backoffMs * 2, RATE_LIMIT_BACKOFF_MAX_MS)
                    : RATE_LIMIT_BACKOFF_MS;
                this._notBefore = Date.now() + this._backoffMs;
            }

            this._error = error.kind === 'rate'
                ? 'usage API rate limited'
                : 'could not reach Anthropic';

            if (this._data)
                this._stale = true;
            else
                this._state = 'error';
            this._render();
        } finally {
            this._refreshing = false;
        }
    }

    _setSignedOut() {
        if (this._destroyed)
            return;
        this._data = null;
        this._error = null;
        this._errorKind = null;
        this._stale = false;
        this._lastUpdated = null;
        this._state = 'signed-out';
        this._render();
    }

    _restoreCache() {
        const cache = this._readCache();
        if (!cache)
            return;

        this._data = {
            session: cache.session ?? null,
            weekly: cache.weekly ?? null,
        };
        this._plan = cache.plan ?? null;
        this._lastUpdated = cache.updated ? new Date(cache.updated) : null;

        if (this._data.session || this._data.weekly) {
            this._state = 'ok';
            this._stale = true;
        }
    }

    _readCache() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CACHE_PATH);
            if (!ok || !bytes)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    _writeCache() {
        if (!this._data)
            return;
        try {
            const dir = Gio.File.new_for_path(GLib.path_get_dirname(CACHE_PATH));
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            const payload = JSON.stringify({
                plan: this._plan,
                updated: Date.now(),
                session: this._data.session,
                weekly: this._data.weekly,
            });
            const file = Gio.File.new_for_path(CACHE_PATH);
            file.replace_contents(
                new TextEncoder().encode(payload), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch {
            // The cache is best-effort.
        }
    }

    _readCredentials() {
        const raw = this._readRawCredentials();
        return raw?.claudeAiOauth ?? null;
    }

    _readRawCredentials() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CREDENTIALS_PATH);
            if (!ok || !bytes)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    async _refreshAccessToken(oauth) {
        if (!oauth.refreshToken)
            return null;

        const payload = {
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: CLIENT_ID,
        };
        if (Array.isArray(oauth.scopes) && oauth.scopes.length)
            payload.scope = oauth.scopes.join(' ');

        const message = Soup.Message.new('POST', TOKEN_URL);
        const headers = message.get_request_headers();
        headers.append('Content-Type', 'application/json');
        headers.append('Accept', 'application/json');
        headers.append('User-Agent', USER_AGENT);
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));

        let bytes;
        try {
            bytes = await sendRequest(this._session, message);
        } catch {
            throw errorWithKind('network', 'network');
        }

        if (this._destroyed)
            return null;

        const status = message.status_code;
        let data = {};
        try {
            data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            data = {};
        }

        if (status === 401 || data.error === 'invalid_grant')
            return null; // refresh token is no longer valid → signed out

        if (status !== 200 || !data.access_token)
            throw errorWithKind(`Token refresh failed (HTTP ${status})`, 'http');

        return this._writeCredentials(oauth.refreshToken, data);
    }

    _writeCredentials(usedRefreshToken, data) {
        // Re-read right before writing. If Claude Code refreshed in the
        // meantime, its file is newer and we must not clobber it.
        const raw = this._readRawCredentials();
        const oauth = raw?.claudeAiOauth;
        if (!oauth)
            return data.access_token;
        if (oauth.refreshToken !== usedRefreshToken) {
            // Someone else (Claude Code) refreshed concurrently; prefer the
            // token that is actually on disk now.
            return oauth.accessToken ?? data.access_token;
        }

        oauth.accessToken = data.access_token;
        if (data.expires_in)
            oauth.expiresAt = Date.now() + data.expires_in * 1000;
        if (data.refresh_token)
            oauth.refreshToken = data.refresh_token;
        if (data.refresh_token_expires_in) {
            oauth.refreshTokenExpiresAt =
                Date.now() + data.refresh_token_expires_in * 1000;
        }
        if (data.scope)
            oauth.scopes = data.scope.split(/\s+/).filter(Boolean);

        try {
            const file = Gio.File.new_for_path(CREDENTIALS_PATH);
            const bytes =
                new TextEncoder().encode(JSON.stringify(raw));
            file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            // replace_contents creates a new file; keep it private.
            file.set_attribute_uint32(
                Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            // If we cannot persist the rotated token we simply keep the old
            // file; Claude Code will refresh on its own next run.
        }
        return data.access_token;
    }

    async _fetchUsage(token) {
        const message = Soup.Message.new('GET', USAGE_URL);
        const headers = message.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', 'oauth-2025-04-20');
        headers.append('anthropic-version', '2023-06-01');
        headers.append('Accept', 'application/json');
        headers.append('User-Agent', USER_AGENT);

        let bytes;
        try {
            bytes = await sendRequest(this._session, message);
        } catch {
            throw errorWithKind('network', 'network');
        }

        const status = message.status_code;
        if (status === 401)
            throw errorWithKind('unauthorized', 'auth');
        if (status === 429)
            throw errorWithKind('rate limited', 'rate');
        if (status !== 200)
            throw errorWithKind(`HTTP ${status}`, 'http');

        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    _parseUsage(data) {
        const limits = Array.isArray(data.limits) ? data.limits : [];
        const severityOf = kind =>
            limits.find(limit => limit.kind === kind)?.severity ?? null;

        const build = (window, kind) => {
            if (!window || typeof window.utilization !== 'number')
                return null;
            const used = clampPercent(window.utilization);
            return {
                used,
                resetAt: window.resets_at ?? null,
                level: levelFor(used, severityOf(kind)),
            };
        };

        return {
            session: build(data.five_hour, 'session'),
            weekly: build(data.seven_day, 'weekly_all'),
        };
    }

    _prettyPlan(subscriptionType) {
        if (!subscriptionType)
            return null;
        return subscriptionType
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }
}
