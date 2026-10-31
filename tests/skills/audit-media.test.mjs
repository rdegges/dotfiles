// Structural and safety invariants for the audit-media skill.
//
// Run from the repo root (ffmpeg and mkvtoolnix are optional; without them the
// mkvpropedit selector test skips):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq ffmpeg mkvtoolnix >/dev/null && node --test tests/skills/'
//
// What a pass proves: the skill hardcodes the user's stack (Jellyfin as the
// server and a primary player, Infuse as a primary player, Seerr for requests, qBittorrent as the
// download client, and Sonarr, Radarr, Prowlarr, Bazarr as the *arr apps), with
// one row per app and no other server, player, request, or download app named;
// it holds no host, IP, tailnet name, URL, or API key (this repo is public) and
// sends the agent to memory or the user for them; it stays read-only before
// Step 5; renames, deletes, remuxes, plugin and settings changes, and restarts
// sit behind an ask; the track policy keeps one default audio, at most one
// default subtitle, and no forced foreign subtitle; Step 6 re-checks every fix
// before "done". With ffmpeg and mkvtoolnix installed, it also proves the
// skill's selector rule (mkvpropedit track:N = ffprobe stream index + 1) on a
// real MKV with a font attachment. It says nothing about the live Jellyfin,
// Seerr, or *arr APIs, or whether an agent obeys the text; that needs a
// supervised run against the real library.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  const others = /\b(Plex|Emby|Kodi|VLC|Overseerr|Jellyseerr|Ombi|Transmission|Deluge|rTorrent|SABnzbd|NZBGet|Lidarr|Readarr|Whisparr|Jackett)\b/gi
  assert.deepEqual(skill.match(others) ?? [], [])
})

test('description names every stack app the skill acts on, and the arg forms', () => {
  const d = frontmatter(skill).description
  for (const app of ['Jellyfin', 'Infuse', 'Seerr', 'Sonarr', 'Radarr', 'qBittorrent', 'Bazarr']) {
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
    /volcanic/i, // the NAS host name
    /https?:\/\//i, // any URL
    /\b[a-z0-9-]+\.(local|lan|home|internal)\b/i, // LAN host names
    /:\d{4,5}\b/, // host:port
    /\b[a-f0-9]{32}\b/i, // *arr / Jellyfin API key shape
  ]
  for (const re of leaks) assert.doesNotMatch(skill, re)
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
