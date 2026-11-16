# pi-headless

A [Pi](https://pi.dev) extension that makes **non-user-initiated shell calls headless**.

Agents hang when a shell command waits for a terminal that isn't there: `jj describe`
opens nvim, `git commit` opens an editor, `git rebase -i` waits for one, `gh` starts a
device flow, ssh asks for a passphrase. The command never returns, the tool call never
completes, and the session sits there until you notice.

`pi-headless` replaces the built-in `bash` tool with the same tool plus a spawn hook that
rewrites the environment, so every one of those programs fails immediately with a message
that says how to do the same thing non-interactively.

```text
# Before: blocks until a human kills it
$ jj describe

# After
$ jj describe
pi-headless: refusing to open an interactive editor.
Agent shell commands run without a TTY. Pass the text explicitly instead
(e.g. jj describe -m 'msg', git commit -m 'msg', jj commit -m 'msg'), or
start Pi with --no-headless if an editor is really intended here.
Error: Failed to edit description
```

## Install

```bash
pi install https://github.com/Crystalix007/pi-headless.git
```

Pin a release if you would rather not track the default branch:

```bash
pi install git:github.com/Crystalix007/pi-headless@v0.1.0
```

Try it for one invocation without installing:

```bash
pi -e https://github.com/Crystalix007/pi-headless.git
```

Undo with `pi remove https://github.com/Crystalix007/pi-headless.git`, and pick up new
commits with `pi update --extensions`. To enable it for one project only, add the same
source to `.pi/settings.json` in that project and `pi install --local ...`.

Check that it is live inside a session with `/headless`.

## What it changes

Only agent-initiated shell calls. Commands you type yourself with `!` or `!!` keep your
normal environment, because those come through Pi's `user_bash` event, which this
extension never intercepts.

| Variables | Value | Hang it prevents |
| --- | --- | --- |
| `PI_HEADLESS` | `1` | nothing — a marker your scripts can test |
| `EDITOR`, `VISUAL`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `JJ_EDITOR`, `SUDO_EDITOR` | guard script (exits 1) | nvim waiting for a keyboard under `jj describe`, `git commit`, `git rebase -i`, `crontab -e`, `kubectl edit` |
| `PAGER`, `GIT_PAGER`, `MANPAGER`, `GH_PAGER`, `SYSTEMD_PAGER`, `BAT_PAGER` | `cat` | pagers that read a keyboard that does not exist |
| `AWS_PAGER` | `""` | the aws cli pager |
| `GIT_TERMINAL_PROMPT` | `0` | git asking for a username, password or token |
| `GIT_SSH_COMMAND` | existing value + `-o BatchMode=yes` | ssh asking for a passphrase or host-key confirmation |
| `SSH_ASKPASS_REQUIRE` | `never` | a GUI askpass dialog nobody will answer |
| `GH_PROMPT_DISABLED` | `1` | `gh auth login` device flows |
| `PIP_NO_INPUT` | `1` | pip asking which index or whether to continue |
| `npm_config_yes` | `true` | `npx`/`npm` install confirmations |
| `DEBIAN_FRONTEND` | `noninteractive` | apt/dpkg debconf prompts |
| `GIT_MERGE_AUTOEDIT` | `no` | `git merge` opening an editor |

Two rules worth knowing:

- **Headless defaults beat your shell.** A `PAGER=less` or `EDITOR=nvim` exported in your
  profile is overridden inside agent commands. Your actual environment is untouched.
- **`CI` is deliberately not set.** Jest and Vitest silently stop writing new snapshots
  when they see it, so headless-by-default must not change commands that would otherwise
  succeed. Add it yourself when you want that trade-off.

The extension also tells the model, in the bash tool's prompt guidelines, that commands
are non-interactive and that `-m`, `-y`, `--no-pager` and friends are preferred over
prompts.

## Configuration

Settings live under a `piHeadless` key in `~/.pi/agent/settings.json` (or `.pi/settings.json`
for one project):

```json
{
  "piHeadless": {
    "enabled": true,
    "env": {
      "CI": "1",
      "GIT_TERMINAL_PROMPT": null
    },
    "timeoutSeconds": 0
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to leave agent commands completely alone |
| `env` | `{}` | Extra variables. Overrides the headless defaults; `null` removes one |
| `timeoutSeconds` | `0` | Default timeout for commands that do not set one. `0` keeps Pi's behaviour of no timeout |

Escape hatches for a single run:

```bash
pi --no-headless          # this session
PI_HEADLESS=0 pi          # same, from the environment
```

`/headless` prints what is currently in force.

## Known limits

- **Hardware-key commit signing still blocks.** A signing key on a YubiKey waits for a
  touch, which no environment variable can prevent. It fails after roughly 30 seconds.
  Turn signing off for agent commands if that wait matters:

  ```json
  {
    "piHeadless": {
      "env": {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "commit.gpgsign",
        "GIT_CONFIG_VALUE_0": "false"
      }
    }
  }
  ```

- **Programs that ignore all hints are not caught.** `watch`, `top`, `tail -f`,
  `ssh host` with no command, a bare `python` or `psql` — these run until something stops
  them. Set `timeoutSeconds` to cap how long an agent can wait.
- **macOS and Linux only.** The editor guard is a POSIX shell script, and the `powershell`
  tool is not overridden.
- **It cannot fix interactivity the agent asks for.** `jj split -i` needs a terminal;
  a guarded editor and closed stdin make it fail fast instead of hanging, which is the
  best available outcome. The prompt guideline is what steers the model away from it.

## How it works

The extension registers `bash` again using Pi's own `createBashToolDefinition()` with a
`spawnHook`. Pi documents that as the supported way to rewrite a command's environment, so
the override keeps the built-in schema, renderer, truncation and `PI_*` session variables
while gaining the headless environment. Editors point at a small guard script written once
to `$TMPDIR/pi-headless-editor.sh`; it prints the explanation above and exits 1, which
tools report as a normal editor failure.

Rewriting the environment rather than the command string means nothing has to be quoted,
a `jj describe` reaches the same binary with the same arguments, and commands that never
needed a terminal are unaffected.

## Development

```bash
npm install
npm test          # unit tests plus real jj/git/pager integration tests
npm run typecheck
pi -e .           # load the checkout for a single run
```

The integration tests run real `jj`, `git` and `less` commands in temporary repositories,
the way Pi runs them (no TTY, closed stdin). They assert each interactive command fails
fast with an explanation instead of waiting for input.

## License

MIT
