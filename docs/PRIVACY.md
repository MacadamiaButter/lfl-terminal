# Privacy Policy - lfl-terminal

Effective date: 2026-07-18

lfl-terminal is a local-first browser extension. Its entire design goal is
that your data stays on your machine. This policy describes exactly what that
means.

## The short version

lfl-terminal collects nothing, sends nothing to us, and has no servers. There
is no account, no login, no analytics, no telemetry, and no tracking of any
kind. We (the developer) never receive any of your data, because there is no
channel by which we could.

## What the extension does with data

- **Page content.** When you explicitly ask the terminal to interpret a
  command it cannot resolve deterministically, the text of your command (and,
  for on-page actions, a list of visible page elements) is sent to the AI
  model endpoint **you** configure, at `http://127.0.0.1:1238` (loopback). By
  default that endpoint is a model **you** run on your own computer, and in
  that default configuration this request never leaves your machine. A
  shared/cohort configuration can instead point that same loopback address at
  a local bridge process that relays the request to a cohort-operated model
  over a private tailnet (never the open internet); in that configuration the
  request does leave your machine, but only to the endpoint you or your
  cohort configured - it is never sent to the developer or any other third
  party either way. If you do not run a local model or bridge, that feature
  simply does nothing.
- **Preferences and command history.** Your themes, aliases, macros, panel
  size, per-site auto-open choices, and recent command history are stored using
  the browser's local extension storage (`chrome.storage.local`) on your own
  device. This data never leaves your device and is never transmitted anywhere.
- **Command-usage memory (opt-in, off by default).** If you turn it on
  (`memory on`), the terminal notes which commands (verbs only, e.g. `search`,
  `go`, `read` - never the arguments or search terms you typed) you use on
  which sites (origin only - scheme and host, never the path or query) so it
  can suggest turning a repeated pattern into a script. It never records page
  content, form values, or what you typed into a page or search box. Stored
  locally (`chrome.storage.local`); `memory show` displays exactly what is
  recorded, `memory forget <site>` or `memory clear` erases it, and
  `memory off` stops all recording.
  This memory is never sent anywhere except your own configured model
  endpoint (see "Page content" above), and only when you turn BOTH `memory`
  and `teach` on and use `teach` yourself: a short summary (verbs, counts,
  and the names of scripts you already have - never arguments, never page
  content) is added as background context to that one request, the same
  loopback request `teach` always makes to `http://127.0.0.1:1238`. In the
  default local configuration it never leaves your machine at all; in a
  shared/cohort configuration it goes only to that same configured endpoint,
  same as any other `teach` request. Either way it is never sent to us or
  any third party, and is never included in the request the terminal makes
  when it interprets an everyday command or `ask` on a page - only `teach`'s
  own drafting request can ever carry it.
- **No network egress to us.** The extension makes no network requests to any
  server operated by the developer, and contains no analytics, advertising, or
  crash-reporting code.

## What we do not collect

We do not collect, store, sell, or share: personal information, browsing
history, page contents, keystrokes, IP addresses, device identifiers, or any
usage statistics. We cannot, because none of it is ever sent to us.

## Permissions

- `storage` - to save your preferences and history locally on your device.
- Host access to `http://127.0.0.1:1238/*` - to talk to the AI model endpoint
  you configure at that loopback address: by default a model you run
  yourself, on your own machine; in a shared/cohort configuration, a local
  bridge you point at that address instead (see "Page content" above).
- Access to page contents (content script) - so the terminal overlay can read
  the current page and, for model-proposed actions, act on it only after your
  explicit approval (commands you type yourself run on your own direct
  intent). Page content is processed locally and, at most, sent to your
  configured model endpoint as described above.

## Changes

If this policy ever changes, the updated version will be published at this URL
with a new effective date.

## Contact

hello@localfirstlab.org
