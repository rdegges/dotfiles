// Structural and safety invariants for the audit-media skill.
//
// Run from the repo root (ffmpeg and mkvtoolnix are optional; without them the
// mkvpropedit selector and track-tag tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq ffmpeg mkvtoolnix >/dev/null && node --test tests/skills/'
//
// What a pass proves: the skill hardcodes the user's stack (Jellyfin as the
// server and a primary player, Infuse as a primary player, Seerr for requests, qBittorrent and
// SABnzbd as the download clients, and Sonarr, Radarr, Prowlarr, Bazarr as the *arr apps), with
// one row per app and no other server, player, request, or download app named;
// it holds no IP, tailnet domain, URL, LAN host name, host:port, or API-key
// shape (this repo is public), and, only when PRIVATE_HOSTS_FILE is set, none
// of the host names listed in that file; it sends the agent to memory or the
// user for them; it stays read-only before
// Step 5, and in Steps 1-4 it reads SABnzbd only through allow-listed read
// calls, with the config read limited to two misc keys; SABnzbd faults are
// report-only under the client-fault rule; renames, deletes, remuxes, plugin and settings changes, and restarts
// sit behind an ask; the track policy keeps one default audio, at most one
// default subtitle, and no forced foreign subtitle; Step 6 re-checks every fix
// before "done". With ffmpeg and mkvtoolnix installed, it also proves the
// skill's selector rule (mkvpropedit track:N = ffprobe stream index + 1) on a
// real MKV with a font attachment, and the track-tag pitfall on a real MKV: a
// per-track LANGUAGE=und tag overrides the header language in ffprobe, and
// mkvpropedit --tags track:N: removes it and keeps the global tags; on an
// mkvmerge-muxed file, --set language alone does not fix it, and the removal
// touches only that track (its statistics tags go with it). No step anywhere
// calls a SABnzbd write mode. It says
// nothing about the live Jellyfin, Seerr, SABnzbd, or *arr APIs, or whether an
// agent obeys the text; that needs a supervised run against the real library.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const skill = readFileSync(new URL('../../dot_claude/skills/audit-media/SKILL.md', import.meta.url), 'utf8')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(m, 'no --- frontmatter block at top of file')
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  return out
}

function section(prefix) {
  const re = new RegExp(`^## ${prefix}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')
  const m = skill.match(re)
  assert.ok(m, `no "## ${prefix}..." section`)
  return m[1]
}

function subsection(body, title) {
  const m = body.match(new RegExp(`^### ${title}\\s*\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm'))
  assert.ok(m, `no "### ${title}" subsection`)
  return m[1]
}

// Rows of the "## The stack" table, keyed by app name.
function stackRows() {
  const rows = {}
  for (const line of section('The stack').split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length !== 3 || cells[0] === 'App' || /^-+$/.test(cells[0])) continue
    assert.ok(!(cells[0] in rows), `${cells[0]} has two rows in the stack table`)
    rows[cells[0]] = { job: cells[1], use: cells[2] }
  }
  return rows
}

// Top-level "- " bullets of a list, with their wrapped and indented lines joined.
function bullets(body) {
  return body.split(/^- /m).slice(1).map((b) => b.replace(/\s+/g, ' ').trim())
}

// --- The hardcoded stack (the user's explicit requirement) ------------------

const STACK = {
  Jellyfin: /media server/i,
  Infuse: /primary player/i,
  Seerr: /request/i,
  Sonarr: /tv|series|episode/i,
  Radarr: /movie/i,
  Prowlarr: /indexer/i,
  Bazarr: /subtitle/i,
  qBittorrent: /download client/i,
  SABnzbd: /usenet download client/i,
}

test('stack table: exactly the user\'s apps, one row each, each with its role', () => {
  const rows = stackRows()
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(STACK).sort())
  for (const [app, role] of Object.entries(STACK)) {
    assert.match(rows[app].job, role, `${app} row does not state its role: "${rows[app].job}"`)
  }
})

test('Jellyfin and Infuse are the primary players; Jellyfin is also the server', () => {
  const rows = stackRows()
  const primary = Object.keys(rows).filter((a) => /primary player/i.test(rows[a].job))
  assert.deepEqual(primary.sort(), ['Infuse', 'Jellyfin'])
  assert.match(rows.Jellyfin.job, /server/i)
})

test('no app outside the stack is named (the skill is not generic)', () => {
  const others = /\b(Plex|Emby|Kodi|VLC|Overseerr|Jellyseerr|Ombi|Transmission|Deluge|rTorrent|NZBGet|Lidarr|Readarr|Whisparr|Jackett)\b/gi
  assert.deepEqual(skill.match(others) ?? [], [])
})

test('description names every stack app the skill acts on, and the arg forms', () => {
  const d = frontmatter(skill).description
  for (const app of ['Jellyfin', 'Infuse', 'Seerr', 'Sonarr', 'Radarr', 'qBittorrent', 'SABnzbd', 'Bazarr']) {
    assert.ok(d.includes(app), `description does not name ${app}`)
  }
  assert.match(d, /\/audit-media/)
  assert.match(d, /'all'/)
  const scope = section('Scope')
  assert.match(scope, /^- No argument:/m)
  assert.match(scope, /^- `all`:/m)
  assert.match(scope, /^- A title or path:/m)
})

test('description fits the 1024-character skill description limit', () => {
  assert.ok(frontmatter(skill).description.length <= 1024)
})

// --- No machine facts in a public repo --------------------------------------

test('no host, IP, tailnet name, URL, or API key is in the skill', () => {
  const leaks = [
    /\b\d{1,3}(\.\d{1,3}){3}\b/, // IPv4
    /\.ts\.net\b/i, // tailnet
    /https?:\/\//i, // any URL
    /\b[a-z0-9-]+\.(local|lan|home|internal)\b/i, // LAN host names
    /:\d{4,5}\b/, // host:port
    /\b[a-f0-9]{32}\b/i, // *arr / Jellyfin API key shape
  ]
  for (const re of leaks) assert.doesNotMatch(skill, re)
})

// Generic patterns cannot catch a bare host name, and listing it here would
// publish it. This test reads host and tailnet names from a file outside the
// repo, one per line ('#' starts a comment), and skips when no file is given.
// List only host names: this skill names its apps on purpose.
//   docker run --rm -v "$PWD":/w -w /w -v /path/to/hosts.txt:/hosts.txt:ro \
//     -e PRIVATE_HOSTS_FILE=/hosts.txt node:latest node --test tests/skills/
const hostsFile = process.env.PRIVATE_HOSTS_FILE

// Keep the 1-based file line with each name, so a hit points at the right line
// even when comments or blank lines come before it.
function parseHostNames(text) {
  return text.split('\n')
    .map((l, i) => ({ line: i + 1, name: l.replace(/#.*/, '').trim() }))
    .filter((e) => e.name)
}

// Case-insensitive substring match, so a name inside a longer token
// (name-nas, name.lan) still counts. A hit holds the source and line, never the name.
function hostNameHits(entries, sources) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hits = []
  for (const [where, text] of sources) {
    for (const { line, name } of entries) {
      if (new RegExp(esc(name), 'i').test(text)) hits.push(`${where}: hosts file line ${line}`)
    }
  }
  return hits
}

test('positive control: the host-name check fires on a planted name, case-insensitive, inside a token', () => {
  const entries = parseHostNames('examplehost-zz9\n')
  assert.deepEqual(hostNameHits(entries, [['doc', 'ssh to EXAMPLEHOST-ZZ9-nas.lan now']]), ['doc: hosts file line 1'])
  assert.deepEqual(hostNameHits(entries, [['doc', 'no such name here']]), [])
})

test('host-name check: comments, blank lines, CRLF, and inline comments are skipped, and hits name the real file line', () => {
  const entries = parseHostNames('# header\r\n\r\n   \r\nexamplehost-zz9 # the box\r\n  # indented comment\r\nother-zz8\r\n')
  assert.deepEqual(entries, [{ line: 4, name: 'examplehost-zz9' }, { line: 6, name: 'other-zz8' }])
  assert.deepEqual(hostNameHits(entries, [['a', 'other-zz8'], ['b', 'examplehost-zz9']]),
    ['a: hosts file line 6', 'b: hosts file line 4'])
  assert.deepEqual(parseHostNames('# only a comment\n\n'), [])
})

test('host-name check: regex metacharacters in a name match only literally', () => {
  const entries = parseHostNames('box.zz9\nnas(1)\n')
  assert.deepEqual(hostNameHits(entries, [['doc', 'boxXzz9 and nas1']]), [])
  assert.deepEqual(hostNameHits(entries, [['doc', 'box.zz9 and nas(1)']]), ['doc: hosts file line 1', 'doc: hosts file line 2'])
})

test('host-name check: a hit never carries the name it found', () => {
  const hits = hostNameHits(parseHostNames('examplehost-zz9\n'), [['doc', 'examplehost-zz9']])
  assert.equal(hits.length, 1)
  for (const h of hits) assert.doesNotMatch(h, /examplehost/i)
})

test('no private host name from PRIVATE_HOSTS_FILE is in the skill or this test file',
  { skip: hostsFile ? false : 'PRIVATE_HOSTS_FILE not set (see the comment above this test)' }, () => {
    assert.ok(existsSync(hostsFile), `PRIVATE_HOSTS_FILE ${hostsFile} does not exist`)
    const entries = parseHostNames(readFileSync(hostsFile, 'utf8'))
    // Fail closed: an empty list proves nothing.
    assert.ok(entries.length > 0, 'PRIVATE_HOSTS_FILE holds no names')
    const self = readFileSync(new URL(import.meta.url), 'utf8')
    // Report the line number in the hosts file, not the name, so logs stay clean.
    assert.deepEqual(hostNameHits(entries, [['SKILL.md', skill], ['test file', self]]), [])
  })

test('Step 1 gets the setup from memory or one question, never a guess', () => {
  assert.match(section('The stack'), /host, the paths, the URLs, and the API keys are not in this skill/)
  const s1 = section('Step 1')
  assert.match(s1, /Read the memory and project notes/)
  assert.match(s1, /ask the user one question/)
  assert.match(s1, /Do not guess a host, a credential, or a path/)
})

// --- Read-only before Step 5; risky changes behind an ask --------------------

test('Steps 1-4 are read-only: the rule is stated and no mutating command appears', () => {
  assert.match(section('Step 1'), /Use read-only commands until Step 5/)
  const early = ['Step 1', 'Step 2', 'Step 3', 'Step 4'].map(section).join('\n')
  const mutating = /mkvpropedit|mkvmerge|removeFromClient|blocklist=|\b(rm|mv)\s|-X\s*(POST|PUT|DELETE|PATCH)|\bDELETE\b|pkill|docker (restart|stop|rm)/g
  assert.deepEqual(early.match(mutating) ?? [], [])
})

test('ask-first list covers rename, delete, re-download, remux, plugins and settings, profiles, restarts', () => {
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).join('\n')
  for (const re of [/Rename or move a media file/, /Delete media/, /download it again/, /Remux or re-encode/,
    /Install a Jellyfin plugin/, /change Jellyfin library settings/, /quality profiles/, /Prowlarr indexers/,
    /Bazarr providers/, /Restart a container/]) {
    assert.match(ask, re)
  }
})

test('no-ask fixes never rename, remux, re-encode, or install, and orphans go to holding, not the trash', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
  for (const b of free) assert.doesNotMatch(b, /\b(rename|remux|re-encode|install a|plugin)\b/i, b)
  const orphans = free.find((b) => b.startsWith('**Orphan subtitle files.**'))
  assert.ok(orphans, 'no orphan-subtitle bullet')
  assert.match(orphans, /holding folder outside the library, not to the trash/)
  const tags = free.find((b) => b.startsWith('**Missing language tags'))
  assert.match(tags, /only when the language is certain/)
  assert.match(tags, /If you are not sure, report it/)
})

test('fake removal goes through the Sonarr/Radarr queue, blocklists, and names the indexer', () => {
  const fakes = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Fake downloads.**'))
  assert.ok(fakes, 'no fake-download bullet')
  assert.match(fakes, /Sonarr or Radarr queue/)
  assert.match(fakes, /removeFromClient=true/)
  assert.match(fakes, /blocklist=true/)
  assert.match(fakes, /Prowlarr indexer/)
})

// --- Track policy and verification -------------------------------------------

test('track policy: one default audio, at most one default subtitle, no forced foreign subtitle', () => {
  const policy = subsection(section('Step 4'), 'The track policy')
  assert.match(policy, /Exactly one audio track and at most one subtitle track have the `default` flag/)
  assert.match(policy, /No foreign subtitle has the `forced` flag/)
  assert.match(policy, /recorded language preference, that preference wins/)
})

test('Step 6 re-probes changed files and gates "done" on its checks', () => {
  const s6 = section('Step 6')
  assert.match(s6, /Run `ffprobe` again on each file that you changed/)
  assert.match(s6, /Check every flag and tag that you wrote in Step 5/)
  assert.match(s6, /exactly one audio track has the `default` flag/i)
  assert.match(s6, /At most one subtitle track has the `default` flag/)
  assert.match(s6, /No foreign subtitle has the `forced` flag/)
  assert.match(s6, /Each language tag that you set is present/)
  assert.match(s6, /must be zero, or you must report each one/)
  assert.match(s6, /Wait for the job to finish/)
  assert.match(s6, /Do not report a fix as done until this step passes/)
})

test('ffprobe comes from the Jellyfin container, not a pulled image', () => {
  assert.match(section('Step 1'), /\/usr\/lib\/jellyfin-ffmpeg\/ffprobe/)
  assert.match(section('Step 1'), /Do not pull a Jellyfin image/)
})

// --- The selector rule, on a real MKV ----------------------------------------

const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0
const tools = ['ffmpeg', 'ffprobe', 'mkvpropedit']
const skip = tools.every(have) ? false : `${tools.filter((t) => !have(t)).join(', ')} not installed (see the run command at the top)`

// Always runs, so the text the real-MKV test below checks cannot drift while it skips.
test('selector rule text: track:N is the ffprobe index + 1, and attachments are not audio', () => {
  assert.match(skill, /The selector `track:N` is the ffprobe stream index \+ 1/)
  assert.match(skill, /Font attachments are streams of type `attachment`/)
})

test('selector rule: mkvpropedit track:(ffprobe index + 1) edits that stream, with a font attachment present', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-media-'))
  const file = join(dir, 'Title (2024).mkv')
  writeFileSync(join(dir, 's.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n')
  writeFileSync(join(dir, 'f.ttf'), 'font')
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64', '-f', 'lavfi', '-i', 'sine=d=1',
    '-f', 'lavfi', '-i', 'sine=d=1', '-i', join(dir, 's.srt'), '-i', join(dir, 's.srt'),
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4', '-c:v', 'mpeg4', '-c:a', 'mp2', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=spa',
    '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:s:0', '0', '-disposition:s:1', 'default+forced',
    '-attach', join(dir, 'f.ttf'), '-metadata:s:t', 'mimetype=font/ttf', file], { encoding: 'utf8' })
  assert.equal(ff.status, 0, ff.stderr)
  const probe = () => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }).stdout)
    .streams.map((s) => ({ index: s.index, type: s.codec_type, lang: s.tags?.language, def: s.disposition.default, forced: s.disposition.forced }))
  const before = probe()
  assert.equal(before.at(-1).type, 'attachment', 'font attachment is not the last stream')
  const audio = (lang) => before.find((s) => s.type === 'audio' && s.lang === lang).index
  const sub = (lang) => before.find((s) => s.type === 'subtitle' && s.lang === lang).index
  // Anime policy: Japanese audio and English dialogue subtitle default; nothing forced.
  const ed = spawnSync('mkvpropedit', ['-q', file,
    '--edit', `track:${audio('eng') + 1}`, '--set', 'flag-default=0',
    '--edit', `track:${audio('jpn') + 1}`, '--set', 'flag-default=1',
    '--edit', `track:${sub('spa') + 1}`, '--set', 'flag-default=0', '--set', 'flag-forced=0',
    '--edit', `track:${sub('eng') + 1}`, '--set', 'flag-default=1',
    '--edit', `track:${audio('jpn') + 1}`, '--set', 'language=jpn'], { encoding: 'utf8' })
  assert.equal(ed.status, 0, ed.stderr + ed.stdout)
  const after = probe()
  const defaults = (type) => after.filter((s) => s.type === type && s.def === 1).map((s) => s.lang)
  assert.deepEqual(defaults('audio'), ['jpn'])
  assert.deepEqual(defaults('subtitle'), ['eng'])
  assert.deepEqual(after.filter((s) => s.forced === 1), [])
  assert.deepEqual(after.map((s) => s.type), before.map((s) => s.type), 'stream layout changed')
})

// --- The track-tag pitfall, on a real MKV --------------------------------------

// Always runs, so the pitfall text the real-file test below checks cannot drift while it skips.
test('track-tag pitfall text: confirm with mkvmerge -J, remove only that track\'s tags, never all tags', () => {
  const pitfalls = section('Known pitfalls')
  assert.ok(pitfalls.includes('`mkvmerge -J`'), 'pitfall does not name `mkvmerge -J`')
  assert.ok(pitfalls.includes('`LANGUAGE=und`'), 'pitfall does not name `LANGUAGE=und`')
  assert.ok(pitfalls.includes('`mkvpropedit --tags track:N:`'), 'pitfall does not name `mkvpropedit --tags track:N:`')
  assert.ok(pitfalls.includes('`--set language` alone does not fix it'), 'pitfall does not say `--set language` alone does not fix it')
  // `--tags all:` also deletes the global tags.
  assert.ok(!skill.includes('--tags all:'), 'the skill names `--tags all:`')
})

// Its own tool list: this test also needs mkvmerge, and the selector test above must not skip for it.
const tagTools = ['ffmpeg', 'ffprobe', 'mkvpropedit', 'mkvmerge']
const tagSkip = tagTools.every(have) ? false : `${tagTools.filter((t) => !have(t)).join(', ')} not installed (see the run command at the top)`

test('track-tag pitfall: a per-track LANGUAGE=und tag overrides the header in ffprobe; --tags track:N: removes it and keeps global tags', { skip: tagSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-media-'))
  const file = join(dir, 'Title (2024).mkv')
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'mpeg4', '-c:a', 'mp2', '-metadata:s:a:0', 'language=jpn', '-metadata', 'comment=keep-me', file], { encoding: 'utf8' })
  assert.equal(ff.status, 0, ff.stderr)
  const probe = () => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }).stdout)
  // Matroska tag names are upper case and ffprobe can report either case, so match keys without regard to case.
  const tagValues = (tags, key) => Object.entries(tags ?? {}).filter(([k]) => k.toLowerCase() === key).map(([, v]) => v)
  const audioLang = () => tagValues(probe().streams.find((s) => s.codec_type === 'audio').tags, 'language')
  const track = probe().streams.find((s) => s.codec_type === 'audio').index + 1
  const xml = join(dir, 'tags.xml')
  writeFileSync(xml, '<?xml version="1.0"?><Tags><Tag><Targets/><Simple><Name>LANGUAGE</Name><String>und</String></Simple></Tag></Tags>')
  const set = spawnSync('mkvpropedit', ['-q', file, '--tags', `track:${track}:${xml}`], { encoding: 'utf8' })
  assert.equal(set.status, 0, set.stderr + set.stdout)
  assert.deepEqual(audioLang(), ['und'], 'ffprobe does not report the per-track LANGUAGE tag over the header language')
  const mm = spawnSync('mkvmerge', ['-J', file], { encoding: 'utf8' })
  assert.equal(mm.status, 0, mm.stderr + mm.stdout)
  assert.equal(JSON.parse(mm.stdout).tracks.find((t) => t.type === 'audio').properties.language, 'jpn')
  const clear = spawnSync('mkvpropedit', ['-q', file, '--tags', `track:${track}:`], { encoding: 'utf8' })
  assert.equal(clear.status, 0, clear.stderr + clear.stdout)
  assert.deepEqual(audioLang(), ['jpn'])
  assert.deepEqual(tagValues(probe().format.tags, 'comment'), ['keep-me'], 'the global tags did not survive')
})

// The test above builds its file with ffmpeg and never runs `--set language`, so it
// cannot see two claims of the pitfall: that `--set language` alone does not fix the
// fault, and that the removal touches only that track. Real releases are muxed by
// mkvmerge, which writes per-track statistics tags (BPS, DURATION, ...); this test
// also pins what the removal does to them, and that mkvpropedit can write them back
// without the stale tag.
test('track-tag pitfall on an mkvmerge-muxed file: --set language alone fails, --tags track:N: clears only that track', { skip: tagSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-media-'))
  const src = join(dir, 'src.mkv')
  const file = join(dir, 'Title (2024).mkv')
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64', '-f', 'lavfi', '-i', 'sine=d=1',
    '-f', 'lavfi', '-i', 'sine=d=1', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'mpeg4', '-c:a', 'mp2',
    '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng', src], { encoding: 'utf8' })
  assert.equal(ff.status, 0, ff.stderr)
  const mux = spawnSync('mkvmerge', ['-q', '-o', file, src], { encoding: 'utf8' })
  assert.equal(mux.status, 0, mux.stderr + mux.stdout)
  const streams = () => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }).stdout).streams
  const tag = (s, key) => Object.entries(s.tags ?? {}).filter(([k]) => k.toLowerCase() === key.toLowerCase()).map(([, v]) => v)
  const audio = () => streams().filter((s) => s.codec_type === 'audio')
  const [jpn, eng] = audio().map((s) => s.index + 1)
  assert.deepEqual(audio().map((s) => tag(s, 'language')), [['jpn'], ['eng']])
  assert.ok(audio().every((s) => tag(s, 'BPS').length === 1), 'mkvmerge wrote no statistics tags; the premise of this test is gone')
  const xml = join(dir, 'tags.xml')
  writeFileSync(xml, '<?xml version="1.0"?><Tags><Tag><Targets/><Simple><Name>LANGUAGE</Name><String>und</String></Simple></Tag></Tags>')
  const prop = (...args) => {
    const r = spawnSync('mkvpropedit', ['-q', file, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr + r.stdout)
  }
  prop('--tags', `track:${jpn}:${xml}`, '--tags', `track:${eng}:${xml}`)
  assert.deepEqual(audio().map((s) => tag(s, 'language')), [['und'], ['und']])
  // The pitfall: `--set language` alone does not fix it.
  prop('--edit', `track:${jpn}`, '--set', 'language=jpn')
  assert.deepEqual(tag(audio()[0], 'language'), ['und'], '`--set language` alone fixed the stale tag; the pitfall text is wrong')
  // The fix removes that track's tags only.
  prop('--tags', `track:${jpn}:`)
  assert.deepEqual(audio().map((s) => tag(s, 'language')), [['jpn'], ['und']], 'the removal touched the other audio track')
  assert.equal(tag(streams().find((s) => s.codec_type === 'video'), 'BPS').length, 1, 'the removal touched the video track tags')
  // Observed cost: the statistics tags of that track go too.
  assert.deepEqual(tag(audio()[0], 'BPS'), [], 'the removal kept the statistics tags (mkvtoolnix changed; revisit the pitfall)')
  // They can be written back, and the stale tag does not come back with them.
  prop('--add-track-statistics-tags')
  assert.equal(tag(audio()[0], 'BPS').length, 1)
  assert.deepEqual(tag(audio()[0], 'language'), ['jpn'])
})

test('the track-tag pitfall says the removal also drops that track\'s statistics tags, and how to write them back', () => {
  assert.match(section('Known pitfalls'), /--add-track-statistics-tags/)
})

// --- Proposals for the maker (do not fail the suite) --------------------------

test('fake auto-removal covers only complete or import-blocked queue items; library files and active downloads need an ask', () => {
  const fakes = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Fake downloads.**'))
  assert.match(fakes, /only Sonarr or Radarr queue items whose download is complete or import-blocked/)
  assert.match(fakes, /library file under 50 MB, or an item that is still downloading, goes under "Needs your decision"/)
  assert.match(fakes, /Never remove or blocklist it without an ask/)
  assert.match(section('Step 4'), /\| Fakes \| A Sonarr or Radarr queue item whose download is complete or import-blocked/)
})

test('Step 1 records how Infuse reaches the library, and Step 7 advice depends on it', () => {
  assert.match(section('Step 1'), /How Infuse reaches the library: SMB .* or a Jellyfin share/)
  assert.doesNotMatch(stackRows().Infuse.use, /directly over SMB/)
  const s7 = section('Step 7')
  assert.match(s7, /If Infuse reads the library over SMB/)
  assert.match(s7, /If Infuse uses a Jellyfin share, the fix is the Jellyfin match/)
})

test('seeding guard: no header edit on a hardlinked or still-seeding file', () => {
  assert.match(section('Step 3'), /link count of each video/)
  const guard = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Seeding guard.**'))
  assert.ok(guard, 'no seeding-guard bullet')
  assert.match(guard, /link count of the file is more than 1, or a qBittorrent torrent still holds the file, do not edit/)
})

test('Seerr reset is behind an ask; the no-ask Seerr bullet only runs the scan job', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
  assert.doesNotMatch(free.find((b) => b.startsWith('**Seerr sync.**')), /unknown/)
  assert.match(bullets(subsection(section('Step 5'), 'Ask before you do these')).join('\n'), /Set a Seerr item to unknown/)
})

// --- Series layout and leftovers of deleted media ----------------------------

test('scope offers series and leftovers runs, and all includes both', () => {
  const scope = section('Scope')
  assert.match(scope, /^- `series`:/m)
  assert.match(scope, /^- `leftovers`:/m)
  assert.match(scope, /full `all` run includes the `series` and `leftovers` checks/)
  assert.match(frontmatter(skill).description, /'series', 'leftovers'/)
})

test('series layout: Sonarr is the source of truth and every known fault class is listed', () => {
  const body = subsection(section('Step 4'), 'Series layout')
  assert.match(body, /Sonarr is the source of truth/)
  for (const f of ['Folder name', 'Duplicate folders', 'Unmanaged folder', 'Missing folder', 'Loose files', 'Wrong library', 'Wrong match', 'No TMDB ID', 'Seerr link']) {
    assert.match(body, new RegExp(`^\\| ${f} \\|`, 'm'), `no "${f}" row`)
  }
})

test('leftovers: all six places are examined, and sizes are reported', () => {
  const body = subsection(section('Step 4'), 'Leftovers from deleted media')
  for (const p of ['Library folders', 'Sonarr and Radarr', 'Jellyfin', 'Seerr', 'qBittorrent', 'Download folders']) {
    assert.match(body, new RegExp(`^\\| ${p} \\|`, 'm'), `no "${p}" row`)
  }
  assert.match(body, /Give the size of each leftover/)
})

test('series and leftover changes that move, add, or delete data sit behind an ask', () => {
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).join('\n')
  for (const re of [/Fix a series folder\. Change the series path in Sonarr with the option that moves the files/,
    /Add an unmanaged series or movie folder to Sonarr or Radarr\. Add it unmonitored and with no search/,
    /Move a series to the other library/, /Remove a series or movie from Sonarr or Radarr when the Leftovers row flags it/, /Move an empty media folder to the holding folder/,
    /Delete a torrent and its data in qBittorrent, or delete files from a download folder\. Give the size of each first/]) {
    assert.match(ask, re)
  }
})

test('the no-ask Jellyfin series match uses only the exact ID from Sonarr, paired by path', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
  const match = free.find((b) => b.startsWith('**Jellyfin series match from Sonarr.**'))
  assert.ok(match, 'no Jellyfin series match bullet')
  assert.match(match, /exact TVDB or TMDB ID that Sonarr has/)
  assert.match(match, /Do this only when Sonarr gives the ID/)
  assert.match(match, /Pair the Jellyfin series with the Sonarr series by path, never by title/)
})

test('Step 6 checks series fixes against Sonarr and Seerr, and reports freed space', () => {
  const s6 = section('Step 6')
  assert.match(s6, /one series item with the Sonarr TVDB and TMDB IDs/)
  assert.match(s6, /disk space that the cleanup made free/)
})

test('Step 3 collects the series and leftover inputs: IDs, types, paths, video counts, and link counts', () => {
  const s3 = section('Step 3')
  assert.match(s3, /For the `series` and `leftovers` checks, also read/)
  assert.match(s3, /Every Sonarr series: path, title, year, TVDB ID, TMDB ID, series type/)
  assert.match(s3, /Every Radarr movie: path, TMDB ID, and whether it has a file/)
  assert.match(s3, /Every Jellyfin series and movie: path and provider IDs \(with a `userId`\)/)
  assert.match(s3, /top level of each library root, and the count of video files in each folder at any depth/)
  assert.match(s3, /`episodeFileDeleted` and `movieFileDeleted`/)
  assert.match(s3, /qBittorrent download folders, with sizes and link counts/)
})

// The series and leftover work adds many destructive actions. Only the fake-download
// bullet may delete through the no-ask path; everything else must stay behind the ask.
test('no-ask fixes never delete data, add or remove *arr items, change a series path or type, or reset Seerr', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .filter((b) => !b.startsWith('**Fake downloads.**'))
  const forbidden = /\b(delete|remove|blocklist|series path|series type|unmonitored|unknown|clear its data)\b/i
  for (const b of free) assert.doesNotMatch(b, forbidden, b)
})

test('the *arr leftovers row needs evidence of an earlier import; an item that never had a file is not a leftover', () => {
  const row = subsection(section('Step 4'), 'Leftovers from deleted media').split('\n').find((l) => l.startsWith('| Sonarr and Radarr |'))
  assert.match(row, /`episodeFileDeleted` or `movieFileDeleted`/)
  assert.match(row, /never had a file is a pending request, not a leftover/)
  assert.match(row, /Only report it/)
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).find((b) => b.startsWith('Remove a series or movie'))
  assert.match(ask, /Never offer to remove an item that never had a file/)
})

test('duplicate series folders: import the unique episodes first, ask about shared ones, keep the Sonarr folder', () => {
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).find((b) => b.startsWith('Fix a series folder.'))
  assert.ok(ask, 'no series-folder ask bullet')
  assert.match(ask, /keep the folder that Sonarr manages/)
  assert.match(ask, /with Sonarr Manual Import/)
  assert.match(ask, /When an episode is in both folders, list both files and ask which one to keep/)
  assert.match(ask, /Never drop a folder that still holds a video file/)
  assert.match(ask, /Sonarr rename function for the episode files/)
})

test('removing a dead *arr item is followed by a Seerr check; a Sonarr-ID match is followed by the Seerr scan', () => {
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).find((b) => b.startsWith('Remove a series or movie'))
  assert.match(ask, /Then make sure that Seerr no longer shows it as "available"/)
  const match = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Jellyfin series match from Sonarr.**'))
  assert.match(match, /Then run the Seerr `jellyfin-full-scan` job/)
})

test('pitfall: a series folder renamed by hand must also change its path in Sonarr', () => {
  assert.match(section('Known pitfalls'), /renamed by hand keeps its old path in Sonarr.*Change the path in Sonarr, not only on disk/)
})

test('Step 6 checks are numbered 1..N with no gap or repeat (the series and leftover checks were inserted mid-list)', () => {
  const nums = section('Step 6').match(/^\d+(?=\. )/gm).map(Number)
  assert.deepEqual(nums, nums.map((_, i) => i + 1))
  assert.match(section('Step 6'), /^8\. After the Bazarr search is complete/m)
})

// The empty-folder move sits behind an ask and is guarded: a series folder keeps its
// videos in season folders, and a pending Sonarr or Radarr item can point at a folder.
test('the empty-folder move is behind an ask, counts at any depth, and skips folders an *arr item points at', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
  assert.ok(!free.some((b) => /empty media folder/i.test(b)), 'empty-folder move is still in the no-ask list')
  const ask = bullets(subsection(section('Step 5'), 'Ask before you do these')).find((b) => b.startsWith('Move an empty media folder'))
  assert.ok(ask, 'no empty-folder ask bullet')
  assert.match(ask, /at any depth/)
  assert.match(ask, /no Sonarr or Radarr item has that path/)
})

test('qBittorrent leftovers need an import record and a missing library file, not only a link count', () => {
  const row = subsection(section('Step 4'), 'Leftovers from deleted media').split('\n').find((l) => l.startsWith('| qBittorrent |'))
  assert.match(row, /import is in the Sonarr or Radarr history/)
  assert.match(row, /link count of 1 alone does not prove this/)
})

test('Step 6 checks moved folders and Seerr after a leftover cleanup', () => {
  assert.match(section('Step 6'), /each folder you moved is in the holding folder and gone from the library root/)
})

// --- qBittorrent client health before a dead-torrent verdict (98080f4) --------
//
// A stalled torrent on a client with no DHT peers or a broken tracker is a client
// fault, not a dead release. These pin that the health inputs are read in Step 3,
// read-only, and that Step 5 refuses removal offers when they show a client fault.

function clientFaultRule() {
  const para = section('Step 5').split(/\n\s*\n/).find((p) => p.startsWith('The qBittorrent and SABnzbd faults from the "Downloads" row are report-only.'))
  assert.ok(para, 'no "The qBittorrent and SABnzbd faults from the Downloads row are report-only." paragraph in Step 5')
  return para.replace(/\s+/g, ' ')
}

test('Step 3 reads qBittorrent client health: dht_nodes and connection_status, and tracker messages of stuck torrents', () => {
  const s3 = section('Step 3')
  assert.match(s3, /`dht_nodes` and `connection_status` from `\/api\/v2\/transfer\/info`/)
  assert.match(s3, /tracker messages \(`\/api\/v2\/torrents\/trackers`\) of at least two stuck torrents \(all of them if fewer are stuck\)/)
})

test('Steps 1-4 name no qBittorrent or *arr write endpoint (the health read stays read-only)', () => {
  const early = ['Step 1', 'Step 2', 'Step 3', 'Step 4'].map(section).join('\n')
  const writes = /\/api\/v2\/(torrents\/(delete|pause|stop|resume|start|recheck|reannounce|add|setCategory)|app\/setPreferences)|\/history\/failed/g
  assert.deepEqual(early.match(writes) ?? [], [])
})

test('client-fault rule: stalled is not proof of a dead release; dht_nodes 0 or a shared tracker error blocks remove and blocklist offers', () => {
  const rule = clientFaultRule()
  assert.match(rule, /report-only/)
  assert.match(rule, /A stuck or stalled state does not prove that a release is dead/)
  assert.match(rule, /If `dht_nodes` is 0, `connection_status` is `disconnected`, or at least two stuck torrents share one tracker error, report the client fault and do not offer to remove or blocklist them/)
})

test('client-fault rule: marking a grab failed through /history/failed counts as a removal', () => {
  assert.match(clientFaultRule(), /`\/history\/failed` blocklists it and starts a re-search, so treat that as a removal/)
})

test('every health field the client-fault rule tests is collected in Step 3 (no verdict on an unread input)', () => {
  // A backticked word after "is " is a value (`disconnected`), not a field name.
  const used = [...clientFaultRule().matchAll(/(?<!is )`([a-z_]+)`/g)].map((m) => m[1])
  assert.ok(used.includes('dht_nodes'), `rule tests no backticked health field; saw ${used.join(', ')}`)
  assert.ok(used.includes('servererror'), `rule tests no SABnzbd server field; saw ${used.join(', ')}`)
  assert.match(clientFaultRule(), /queue-level `paused` of true/)
  for (const f of used) assert.ok(section('Step 3').includes(`\`${f}\``), `rule uses \`${f}\`, which Step 3 never reads`)
  assert.match(section('Step 3'), /tracker messages/)
})

test('the no-ask path never marks a grab failed (a blocklist and re-search by another name)', () => {
  const free = bullets(subsection(section('Step 5'), 'Fix these without asking'))
  for (const b of free) assert.doesNotMatch(b, /\/history\/failed|mark(ed|s)? (it |the grab )?(as )?failed/i, b)
})

// Proposal for the maker: the rule as written cannot tell "DHT is off" from "DHT is
// broken".
test('PROPOSED CONTRACT: the client-fault rule tells DHT turned off (private trackers) from DHT with no nodes', { todo: true }, () => {
  assert.match(clientFaultRule(), /DHT is (off|disabled)|private torrent|private tracker/i)
})

test('client-fault rule gives connection_status a meaning: `disconnected` is a client fault', () => {
  assert.match(clientFaultRule(), /`connection_status` is `disconnected`/)
})

test('the Fake downloads ask path defers to the client-fault rule for items still downloading', () => {
  const fakes = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Fake downloads.**'))
  assert.match(fakes, /client-fault rule/)
})

// --- SABnzbd: allow-listed reads, report-only faults --------------------------
//
// SABnzbd writes are plain GET calls (mode=pause, mode=set_config, and a name=
// parameter on a read mode), so the -X POST/PUT/DELETE guard cannot see them.
// An allow-list of read modes catches writes that a deny-list would have to name.

test('Steps 1-4 call SABnzbd only through allow-listed read modes, with no name= or value= parameter', () => {
  const early = ['Step 1', 'Step 2', 'Step 3', 'Step 4'].map(section).join('\n')
  const reads = new Set(['queue', 'history', 'status', 'warnings', 'get_config'])
  for (const m of early.matchAll(/mode=([a-z_]+)/g)) assert.ok(reads.has(m[1]), `mode=${m[1]} is not an allow-listed SABnzbd read`)
  for (const m of ['queue', 'history', 'status', 'warnings']) assert.match(early, new RegExp(`mode=${m}\\b`), `Steps 1-4 never read mode=${m}`)
  assert.doesNotMatch(early, /\bname=\w/)
  assert.doesNotMatch(early, /\bvalue=/)
  // A bare get_config returns the whole config, API keys in clear text.
  for (const m of early.matchAll(/mode=get_config/g)) {
    // The call must end after the key: a trailing `&section=servers` or second keyword widens the read.
    assert.match(early.slice(m.index + m[0].length), /^&section=misc&keyword=(complete_dir|download_dir)(?![\w&=])/,
      'a mode=get_config call is not limited to the misc keys complete_dir and download_dir')
  }
})

// The Steps 1-4 test above cannot see Steps 5-7. SABnzbd faults are report-only and
// fakes leave SABnzbd through the Sonarr or Radarr queue, so no step may call a
// SABnzbd write: a later step that adds one must change this test on purpose.
test('no step anywhere in the skill calls a SABnzbd write mode or passes name= or value=', () => {
  const reads = new Set(['queue', 'history', 'status', 'warnings', 'get_config'])
  const modes = [...skill.matchAll(/mode=([A-Za-z_]+)/g)].map((m) => m[1])
  assert.ok(modes.length >= 5, `only ${modes.length} mode= calls found; the scan is not seeing the SABnzbd reads`)
  for (const m of modes) assert.ok(reads.has(m), `mode=${m} is not an allow-listed SABnzbd read`)
  assert.doesNotMatch(skill, /\bname=\w/)
  assert.doesNotMatch(skill, /\bvalue=/)
})

test('the SABnzbd seeding-guard pass does not waive the link-count check', () => {
  const guard = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Seeding guard.**'))
  const usenet = guard.split(/(?<=\.) /).find((s) => /SABnzbd/.test(s))
  assert.match(usenet, /link count/)
})

test('the SABnzbd status read keeps only the listed fields (the response carries the API key)', () => {
  assert.match(section('Step 3'), /mode=status[^.]*(only these fields|drop|filter|never print|API key)/i)
})

test('Step 1: a GET is not read-only by itself, and the config read is two misc keys, never the whole config', () => {
  const s1 = section('Step 1')
  assert.match(s1, /SABnzbd API writes are GET calls; a GET is not read-only by itself/)
  assert.ok(s1.includes('only the `misc` keys `complete_dir` and `download_dir`'), 'Step 1 does not limit get_config to the two misc keys')
  assert.match(s1, /never the whole config/)
})

test('Step 3 reads the SABnzbd queue, failed history, server status, and warnings, with every field the faults use', () => {
  const s3 = section('Step 3')
  assert.ok(s3.includes('mode=history&failed_only=1&limit=50'), 'no bounded failed-history read')
  assert.ok(s3.includes('mode=status&skip_dashboard=1'), 'no server-status read')
  assert.ok(s3.includes('never with a `name=` parameter'), 'Step 3 does not ban the name= parameter')
  for (const f of ['status', 'percentage', 'cat', 'labels', 'fail_message', 'category', 'completed', 'servername', 'serveractive', 'servererror', 'text']) {
    assert.ok(s3.includes(`\`${f}\``), `Step 3 does not read \`${f}\``)
  }
})

test('client-fault rule: a usenet server error blocks remove and blocklist offers for failed SABnzbd jobs', () => {
  assert.match(clientFaultRule(), /do not offer to remove or blocklist failed SABnzbd jobs while it holds/)
})

test('Downloads row names the SABnzbd faults, and the Download folders leftover counts SABnzbd jobs', () => {
  const downloads = section('Step 4').split('\n').find((l) => l.startsWith('| Downloads |'))
  assert.match(downloads, /SABnzbd/)
  assert.ok(downloads.includes('`Failed`'), 'Downloads row does not name `Failed`')
  const body = subsection(section('Step 4'), 'Leftovers from deleted media')
  assert.match(body, /^\| Download folders \| Files or folders that no torrent, no SABnzbd job, and no queue item holds\. \|$/m)
  const rows = body.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Place |'))
  assert.equal(rows.length, 6, `leftovers table has ${rows.length} rows, not 6`)
})

test('seeding guard: a file that only SABnzbd downloaded passes the guard', () => {
  const guard = bullets(subsection(section('Step 5'), 'Fix these without asking'))
    .find((b) => b.startsWith('**Seeding guard.**'))
  assert.match(guard, /A usenet import is a move with no seeding, so a file that only SABnzbd downloaded passes the guard when its link count is 1\./)
})

test('Audio row: only commentary or audio-description audio left is missing main audio, never a default-flag fix', () => {
  const audio = section('Step 4').split('\n').find((l) => l.startsWith('| Audio |'))
  assert.ok(audio.includes('`zxx`'), 'Audio row does not name `zxx`')
  assert.match(audio, /never a default-flag fix/)
  assert.match(audio, /report it under "Needs your decision"/)
})
