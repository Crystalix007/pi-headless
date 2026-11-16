# pi-headless

A [Pi](https://pi.dev) extension that runs agent shell commands headless, so they cannot
hang waiting for a terminal.

`jj describe` opens nvim. `git commit` opens an editor. `gh` starts a device flow. None of
them can finish inside a tool call, so the agent waits with them. This extension makes
each of those fail immediately, with a message that says what to do instead.

```text
$ jj describe
pi-headless: refusing to open an interactive editor.
Agent shell commands run without a TTY. Pass the text explicitly instead
(e.g. jj describe -m 'msg', git commit -m 'msg'), or start Pi with
--no-headless if an editor is really intended here.
Error: Failed to edit description
```

## Install

```bash
pi install https://github.com/Crystalix007/pi-headless.git
```

Then run `/headless` in a session to confirm it is active. Useful variations:

```bash
pi install git:github.com/Crystalix007/pi-headless@v0.1.0  # pin a release
pi -e https://github.com/Crystalix007/pi-headless.git      # try it once
pi update --extensions                                     # update later
pi remove https://github.com/Crystalix007/pi-headless.git  # uninstall
```

Add `--local` to install for the current project only.

## What changes

Agent-initiated commands only. Your own `!` commands keep your normal environment.

| Variables | Value | Stops |
| --- | --- | --- |
| `EDITOR`, `VISUAL`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `JJ_EDITOR`, `SUDO_EDITOR` | guard script, exits 1 | editors in `jj describe`, `git commit`, `git rebase -i`, `crontab -e` |
| `PAGER`, `GIT_PAGER`, `MANPAGER`, `GH_PAGER`, `SYSTEMD_PAGER`, `BAT_PAGER` | `cat` | pagers waiting for a keyboard |
| `AWS_PAGER` | `""` | the aws cli pager |
| `GIT_TERMINAL_PROMPT`, `GIT_SSH_COMMAND` (+`BatchMode=yes`), `SSH_ASKPASS_REQUIRE`, `GH_PROMPT_DISABLED`, `PIP_NO_INPUT`, `npm_config_yes`, `DEBIAN_FRONTEND`, `GIT_MERGE_AUTOEDIT` | non-interactive values | prompts for tokens, passphrases, host keys, packages, debconf |
| `PI_HEADLESS` | `1` | nothing; lets your scripts detect a headless run |

Two rules worth knowing:

- **The defaults beat your shell.** An exported `PAGER=less` or `EDITOR=nvim` is overridden
  inside agent commands only.
- **`CI` is not set.** Jest and Vitest stop writing snapshots when they see it, so
  headless-by-default must not change commands that would have succeeded.

The extension also tells the model that commands are non-interactive, so it reaches for
`-m`, `-y` and `--no-pager` instead of a prompt.

## Configure

In `~/.pi/agent/settings.json`, or `.pi/settings.json` for one project:

```json
{
  "piHeadless": {
    "enabled": true,
    "env": { "CI": "1", "GIT_TERMINAL_PROMPT": null },
    "timeoutSeconds": 0
  }
}
```

- `env` adds or overrides variables; `null` removes one.
- `timeoutSeconds` caps commands that would otherwise never return (`0`, the default, keeps
  Pi's no-timeout behaviour).
- `pi --no-headless` or `PI_HEADLESS=0 pi` disables it for a single run.

## Limits

- **Hardware-key signing still waits for a touch** (~30s). To skip it for agent commits:
  `"env": { "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "commit.gpgsign", "GIT_CONFIG_VALUE_0": "false" }`.
- **Programs that ignore every hint are not caught**: `watch`, `tail -f`, a bare `python`.
  Set `timeoutSeconds`.
- **macOS and Linux only.** The editor guard is a POSIX shell script, and the `powershell`
  tool is not overridden.

## Development

```bash
npm install && npm test && npm run typecheck
pi -e .    # load this checkout for one run
```

The tests run real `jj`, `git` and `less` commands without a TTY and assert they fail fast.

MIT
