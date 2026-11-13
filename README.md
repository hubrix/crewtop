# crewtop

htop for agents running and tokens burned: a terminal dashboard of coding-agent
activity and usage, built on [ccusage](https://github.com/ryoppippi/ccusage).

One screen shows every crew machine. A hub runs the dashboard and starts
`crewtop collect --stream` on each member over SSH while someone is watching. When
the dashboard closes, each collector sees stdin close and exits, so nothing runs on
a member while nobody is watching.

## Run it

Needs Node 24. There is no build step, and ccusage is the only runtime dependency.

```sh
npm ci --omit=dev --ignore-scripts
bin/crewtop                 # the fleet config's members, or this machine if there is no config
bin/crewtop --local         # this machine alone
bin/crewtop --fleet <path>  # the members in another config file
```

`bin/crewtop collect --stream` prints the collector's frames instead. It stops
when stdin closes, so run it from a terminal or with stdin held open.

## Fleet

List the members in `~/.config/crewtop/fleet.toml` (`$XDG_CONFIG_HOME/crewtop/fleet.toml`
if that is set). [`fleet.example.toml`](fleet.example.toml) is a documented starting
point; the Debian package installs it in `/usr/share/doc/crewtop/`.

```toml
[[member]]
name = "hub"            # shown on screen
local = true            # the machine the dashboard runs on

[[member]]
name = "box-a"
ssh = "box-a"           # an alias from ~/.ssh/config, or [user@]host
```

Each `ssh` member needs crewtop on its PATH for a non-interactive SSH session, and
the hub's key must log in with no prompt: the hub uses `BatchMode=yes`, and it does
not accept unknown host keys. A bad config stops the dashboard with its line number.
The hub never installs or changes anything on a member.

Rows are grouped by machine in config order. Press F5 or `g` to sort across the fleet.

| Member state | Trigger | What the screen does |
|---|---|---|
| grey, `stale 41s` | No `live` frame for 7 s, or the link dropped | Last values stay, greyed, with their age. They leave burn and agent counts, and stay in today's total. |
| `unreachable` | The first connection failed, or a lost member stayed lost for 5 minutes | Numbers are hidden. The meter gives the reason: `no ssh link`, `crewtop not found` or `collector exited`. |
| `update needed` | The member's frames fail this build's validation | Its numbers stay out of the rows and the totals. |

A dead link is detected by ssh keepalives (5 s x 2), and a frozen collector by a 20 s
watchdog on the hub. Reconnects back off from 3 s to 30 s. A reconnect discards burn
samples, so tokens spent during an outage never read as a rate: TOK/M and $/H show `-`
until two new usage frames arrive. Each member has its own process and pipe, so one
member being down or slow does not touch another's rows. The header's today total says
`(2/3 machines)` when it is partial.

Below 100 columns MODEL and UP drop; below 80 TOKENS and the meter bars drop; below
60 the table is host, agent, state and $/H. There, hosts are initials (`h`, `ba`, `bb`)
and the meter lines keep the full names.

## Debian package

```sh
scripts/build-deb.sh
```

This builds `dist/crewtop_<version>_amd64.deb` for Ubuntu 26.04 on amd64, then
unpacks it and smoke-tests it. It needs `curl`, `xz` and `dpkg-deb`, and no system
Node. The package holds crewtop, its production `node_modules` and a Node 24 runtime
under `/usr/lib/crewtop`, with the launcher at `/usr/bin/crewtop`. It has no
`nodejs` dependency, because the launcher only uses the bundled runtime. The Node
version and checksum are pinned at the top of the script. The salt is not packaged:
crewtop creates it per user at run time.

## What the screen means

| Mark | Meaning |
|---|---|
| `-` | No sample yet. |
| `n/a` | ccusage has no adapter for this agent, or a model has no price. |
| grey, `stale 41s` | Three `live` frames missed, or the link dropped. Values shown are the last seen. |
| `unreachable` | The member has been lost too long, or never connected. Numbers are hidden until it returns. |

Neither `-` nor `n/a` means zero. Cost is the API-equivalent price from ccusage's
table, not what a subscription is charged. TOK/M counts input + output over 5
minutes; press `c` to add cache tokens. Today's total is the current UTC day.

Keys: arrows and PgUp/PgDn move, F3 or `/` find, F4 or `f` filter, F5 or `g` group by
machine, F6 or `s` sort, `i` usage rows with no live agent, `c` cache, Enter exact
counters, F1 help, `q` quit.

## Where the numbers come from

- **Tokens and cost:** the pinned ccusage, run as
  `nice -n 10 ccusage session --json --offline --timezone UTC --config <empty file>`,
  one child at a time, with stderr discarded and a 30 s timeout. crewtop never opens
  a transcript.
- **Running now:** `herdr agent list` is the authority for state. It runs against the
  default server and against each other running session that `herdr session list`
  names, all within one 5 s deadline. An agent seen in two sessions counts once, and
  a session that is down is skipped. Session names and socket paths stay on the
  machine. The process table catches agents Herdr does not show, as `src: proc` rows
  with state `unknown`. Logs never decide liveness.
- **Refresh:** repaint 1 s, liveness 2 s, usage 15-120 s (adapts to ccusage's CPU
  cost), today's total 60 s.

## Privacy

This is everything that leaves the collector:

| On the wire | What it holds |
|---|---|
| Token counts, cost, times | Numbers, and UTC timestamps of last activity |
| Session key | A 12-hex HMAC of the session id, keyed with a per-host salt |
| Agent name | The closed list in `src/agents.ts`, or `other` |
| State, source, error code, OS | Fixed enums |
| Model name | A lowercase name in a known family (`claude-`, `gpt-`, `o3` and so on), or `default`. Anything else is sent as `other` |
| Seat | A Herdr pane id such as `w1:p1` |
| Versions | The crewtop and ccusage version numbers |
| Host | The constant `unnamed-host`, never the machine's name |

The model name check looks at the start of the name and its characters. A private
label that begins like a known family, such as `claude-acme`, still crosses.

The hub names a member from its config. The local view with no config reads
`os.hostname()` itself, so that name never crosses the wire.

The collector builds frames field by field, and `src/wire.ts` rejects any frame with
an unknown key or a string outside its pattern, on the way out and again on the way
into the TUI, so the hub trusts nothing a member sends. ssh's stderr is discarded,
because it carries hostnames and paths; only its exit code is read, and it maps to a
closed list of reasons. The hub runs only the fixed command `crewtop collect
--stream`, and writes nothing on disk. Session ids are keyed with a per-host salt at
`~/.local/state/crewtop/salt` (mode 0600), which is the only file crewtop writes.

ccusage runs with `--offline`, from `/`, with `--config` pointing at an empty file in
the package. Its environment holds only
`PATH`, `HOME`, the XDG config, data and cache paths, and each agent's log directory
variable. So a `.ccusage/ccusage.json` in the directory you launch from, your own
ccusage config, secrets in your environment and `CCUSAGE_MODEL_ALIASES` have no effect
on it. Herdr and ssh still inherit the normal environment.

`test/privacy-canary.test.ts` plants markers in synthetic logs, model names, Herdr
output, process arguments and the environment, runs the real collector and the real
ccusage, and fails if any marker appears. It also runs the collector from a directory
holding a hostile ccusage config, and runs the real dashboard through a fake `ssh`,
which plants markers in ssh's stderr, in a login banner and in frames that break the
allowlist. Fixtures are synthetic. Never commit real logs.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run verify-local     # this machine: tokens against ccusage, state against Herdr
npm run verify-fleet     # real members: grey-out, outage and recovery, by interrupting a local ssh client
npm run record-fixture   # after a deliberate ccusage bump
```

ccusage is pinned exactly, because its JSON can change between releases. A bump
changes `package.json`, the lockfile and the recorded fixture in one PR, and the
contract test must pass.

## License

crewtop is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). See [LICENSE](LICENSE).
