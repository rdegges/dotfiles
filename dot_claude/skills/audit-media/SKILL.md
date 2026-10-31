---
name: audit-media
description: "Audit the home media library and fix what stops it from working well in Jellyfin, Infuse, and Seerr: file and folder names, audio and subtitle tracks, default-track flags, orphan subtitle files, metadata matches, Seerr sync, Bazarr gaps, and stuck or fake downloads in Sonarr, Radarr, and qBittorrent. Use when the user runs /audit-media, says they downloaded new media, or asks to make sure that the library works in Jellyfin, Infuse, or Seerr. Args: none (new media since the last audit), 'all' (whole library), or a title or path."
---

# Audit media

This skill finds and fixes library faults that make Jellyfin, Infuse, or Seerr
show the wrong title, play the wrong audio, or miss subtitles.

## The stack

| App | Job | What the audit uses it for |
|---|---|---|
| Jellyfin | Media server and primary player (Jellyfin apps and web UI) | Matches, provider IDs, library scans, metadata refresh, user language settings. |
| Infuse | Primary player (Apple TV, iPhone, iPad) | Plays the files. Over SMB, it gets its own metadata from TMDB and uses the file names, the sidecar names, and the default-track flags. Through a Jellyfin share, it uses the Jellyfin metadata. |
| Seerr | Requests | Must show every library item as "available" and link to the current Jellyfin item ID. |
| Sonarr | TV and anime downloads | Episode numbering (TVDB), series type (`anime` or `standard`), original language, renames, queue. |
| Radarr | Movie downloads | Original language, renames, queue. |
| Prowlarr | Indexers | Find the indexer that served a fake release. |
| Bazarr | Subtitles | Search for missing subtitles. |
| qBittorrent | Download client | Torrent states. Remove fake torrents and their files (through the Sonarr or Radarr queue). |

The host, the paths, the URLs, and the API keys are not in this skill. Step 1 finds them.

## Scope

- No argument: audit the files that changed since the last audit. If no earlier audit is on record, use the last 7 days.
- `all`: audit the whole library. Tell the user how many files that is before you start.
- A title or path: audit only that item.

## Step 1: Find the setup

1. Read the memory and project notes for these facts:
   - The host that stores the media, and how to reach it.
   - The library root folders, and which Jellyfin library uses each one (movies, shows, anime).
   - How the library path maps between the host, the Jellyfin container, Sonarr, Radarr, and qBittorrent, so that each command uses the path that exists where it runs.
   - How to reach the API of each app in the stack, and where each API key is.
   - How Infuse reaches the library: SMB (its own TMDB metadata) or a Jellyfin share (Jellyfin metadata).
   - Any helper scripts that already exist for these APIs.
   - The language preferences of the user. For example: "anime in Japanese with English subtitles".
2. If a fact is not on record, ask the user one question that covers all the missing facts. Do not guess a host, a credential, or a path.
3. Record new facts in memory when the audit is complete.

Use read-only commands until Step 5. Run `ffprobe` from inside the Jellyfin container (`/usr/lib/jellyfin-ffmpeg/ffprobe`). Do not pull a Jellyfin image to get the tool.

## Step 2: List the files to audit

1. Find the video files in scope (`.mkv`, `.mp4`, `.m4v`, `.avi`, `.ts`, `.m2ts`, `.mov`, `.wmv`). Use the modification time and the change time, because a rename changes only the change time.
2. Skip hidden folders, `@eaDir`, `.trickplay`, and other app folders.
3. Also list the sidecar files (`.srt`, `.ass`, `.vtt`, `.sub`, `.idx`, `.nfo`) in the same folders.
4. Group the results by movie or by show. Large batches with one timestamp usually come from a rename, not from new downloads. Say so in the report.

## Step 3: Collect the data

1. Run `ffprobe -show_streams -show_format -of json` on each video. Record for each stream: index, type, codec, language tag, title, `default` flag, `forced` flag, `comment` and `visual_impaired` flags, channels, and height. Font attachments are streams of type `attachment`, not audio.
2. Record the link count of each video (`stat -c %h`, or `stat -f %l` on BSD and macOS).
3. Ask Jellyfin for each item: the matched title, year, season and episode numbers, and provider IDs (TMDB, TVDB, IMDb). Always pass a `userId`. Without one, Jellyfin does not list movies that are in collections.
4. Read the audio and subtitle settings of each Jellyfin user. If a user has no audio language preference, Jellyfin plays the track that has the `default` flag. Infuse does the same when it has no language setting. This makes default flags important.
5. Get the original language of each title from Sonarr or Radarr (`originalLanguage`). Get the series type from Sonarr. A series of type `anime` uses the anime policy below, even when it is in the shows library.
6. Read the Sonarr and Radarr queues, including status messages and the download state of each item.
7. Read the qBittorrent torrent list: state, progress, category, and save path. Find the torrents that still hold a file in scope.
8. Read the Seerr media list. Compare it with the Jellyfin movies and series by TMDB ID.
9. Read the Bazarr "wanted" lists for the items in scope.

## Step 4: Find the faults

Examine every item for each fault in this table.

| Area | Fault |
|---|---|
| Names | A movie is not in its own folder `Title (Year)/`. The file name does not start with the folder name. An episode file has no `SxxEyy`. The season folder number does not agree with `Sxx`. Specials are not in `Season 00` or `Specials`. |
| Sidecars | An orphan subtitle is a subtitle file that has no video in its folder whose base name it can belong to. A subtitle next to its video but with a different base name is a name fault, not an orphan: neither Jellyfin nor Infuse loads it, and it goes to the ask list. A subtitle file with no language code (`Movie.srt`) shows as "und" in Jellyfin. |
| Jellyfin match | The item has no provider IDs. The matched title or year is wrong. Episodes have no metadata. |
| Numbering | Sonarr uses TVDB episode order. Jellyfin uses TMDB by default. The two orders often differ for anime and old shows. Compare the episode counts per season. |
| Audio | The file has no audio. The audio has no language tag. More than one audio track has the `default` flag. The default track does not agree with the track policy. |
| Subtitles | A foreign subtitle has the `default` or `forced` flag. The audio is not in the language of the user, and the file has no subtitle in that language (embedded or sidecar). |
| Format | The container is not MKV or MP4. The video codec is not H.264, HEVC, or AV1. Infuse plays these files, but Jellyfin must transcode them for the web UI. |
| Fakes | A Sonarr or Radarr queue item whose download is complete or import-blocked holds a "video" smaller than 50 MB, or a folder with ads (`.txt`, `.jpg`, `.lnk`, `.exe`) and no real video. A library file under 50 MB, or an item that is still downloading, is a suspect only. |
| Queue | A Sonarr or Radarr download is stuck at "import pending" or shows a warning. |
| Downloads | A qBittorrent torrent is in the `error` or `missingFiles` state, is stalled while it gets metadata, or has no Sonarr or Radarr queue entry and no category. |
| Seerr | An item is in Jellyfin but not "available" in Seerr. Seerr links to a Jellyfin item ID that no longer exists. An "available" item has no Sonarr or Radarr link. |

Ignore these, because they cause no fault:

- A file that has many foreign subtitle tracks but correct default flags.
- An app folder like `@eaDir`.

### The track policy

Use this policy to find the correct default tracks. If the user has a recorded language preference, that preference wins.

1. Select the default audio:
   - Anime (in the anime library, Sonarr type `anime`, or a Japanese animated film): Japanese. If the file has no Japanese track, use the English dub.
   - Other titles: the track in the original language. If that language is not English and the file has no English subtitle, use the English dub.
   - Never pick a commentary or audio-description track as the default audio. Find these tracks by the track title, or by the `comment` and `visual_impaired` flags.
2. Select the default subtitle:
   - If the default audio is English, set no default subtitle. An English forced subtitle keeps its `forced` flag.
   - Otherwise, use the full English dialogue subtitle. Do not use "Signs & Songs", forced, or SDH tracks for this, unless no other track exists.
3. Exactly one audio track and at most one subtitle track have the `default` flag. No foreign subtitle has the `forced` flag.

## Step 5: Fix the faults

### Fix these without asking

These fixes are easy to undo.

- **Seeding guard.** Do this before each `mkvpropedit` edit (flags or language tags). If the link count of the file is more than 1, or a qBittorrent torrent still holds the file, do not edit the file. Put it under "Needs your decision", and give the cause: the edit changes the data of the seeding torrent, and a recheck downloads those pieces again and undoes the fix.
- **Default and forced flags on MKV files.** Use `mkvpropedit`. It edits only the header and takes seconds. The selector `track:N` is the ffprobe stream index + 1. If `mkvpropedit` is not installed, run it in a small throwaway container (`alpine` with `apk add mkvtoolnix`) that mounts the library.

  ```sh
  mkvpropedit "/media/Movies/Title (2024)/Title (2024).mkv" \
    --edit track:2 --set flag-default=0 \
    --edit track:3 --set flag-default=1 \
    --edit track:5 --set flag-default=0 --set flag-forced=0
  ```

- **Missing language tags on MKV audio.** Use `mkvpropedit --set language=<code>`. Do this only when the language is certain: from the track title, or because the file has one audio track and the original language is known. If you are not sure, report it.
- **Missing subtitles.** Start a Bazarr search for the item.
- **Orphan subtitle files.** Move them to a holding folder outside the library, not to the trash. Write the folder path in the report.
- **Fake downloads.** This covers only Sonarr or Radarr queue items whose download is complete or import-blocked. Remove the item from the Sonarr or Radarr queue with `removeFromClient=true` and `blocklist=true`. This deletes the torrent and its files from qBittorrent, and Sonarr or Radarr searches again. Name the Prowlarr indexer that served it in the report. A library file under 50 MB, or an item that is still downloading, goes under "Needs your decision". Never remove or blocklist it without an ask.
- **Jellyfin metadata.** Refresh an item that has no match. Then start a library scan.
- **Seerr sync.** After renames, run the Seerr `jellyfin-full-scan` job.

### Ask before you do these

- Rename or move a media file or folder. Use the Sonarr or Radarr rename function when it manages the item, so that their records stay correct. This includes a subtitle file that is next to its video but has a different base name.
- Delete media, or download it again.
- Remux or re-encode a file. MP4 flags and tags cannot be changed in place, so they need a remux.
- Set a Seerr item to unknown, or clear its data. First make sure that the item is truly missing from Jellyfin: it is not only unmatched (no provider IDs), and it is not a series that has only a TVDB ID.
- Install a Jellyfin plugin, or change Jellyfin library settings. For an episode-order mismatch, the usual fix is the TheTVDB plugin as the first metadata source for that library. Back up the library settings first.
- Change Sonarr or Radarr quality profiles or custom formats, Prowlarr indexers, or Bazarr providers.
- Restart a container while someone is watching. Read the Jellyfin active sessions first.

The qBittorrent faults from the "Downloads" row are report-only. Put them under "Needs your decision".

## Step 6: Make sure that the fixes worked

1. Run `ffprobe` again on each file that you changed. Check every flag and tag that you wrote in Step 5:
   - Exactly one audio track has the `default` flag, and it is the track you selected.
   - At most one subtitle track has the `default` flag.
   - No foreign subtitle has the `forced` flag.
   - Each language tag that you set is present.
2. Start a Jellyfin library scan.
3. Read the Jellyfin match data again for each item you refreshed. Count the episodes that still have no provider IDs. The number must be zero, or you must report each one.
4. Read the Sonarr and Radarr queues again after you remove fakes.
5. The Seerr `jellyfin-full-scan` job runs in the background. Wait for the job to finish. Then compare Seerr with Jellyfin again. The count of stale IDs and missing items must be zero, or you must report each one.
6. After the Bazarr search is complete, list each file that still has no subtitle in the language of the user. Put it under "Left as is" or "Needs your decision".

Do not report a fix as done until this step passes.

## Step 7: Report

Start with the result in one sentence. Then give three short lists:

- **Fixed:** each item, the fault, and the change.
- **Needs your decision:** each item, the fault, the fix you recommend, and what it changes.
- **Left as is:** each low-impact fault, and the reason.

If Infuse reads the library over SMB, it keeps its own metadata. If it shows wrong episode data after a numbering fix, tell the user to fix the match in Infuse. If Infuse uses a Jellyfin share, the fix is the Jellyfin match.

Record in memory: the date of this audit (it sets the next default scope), new facts about the setup, and any new pitfall.

## Known pitfalls

- Jellyfin item IDs come from the file path. A rename gives the item a new ID, resets watch progress, and breaks the links in Seerr. Run the Seerr sync job after renames.
- Some Jellyfin API responses start with a UTF-8 byte order mark after a restart. Remove it before you parse the JSON.
- A Jellyfin plugin install takes effect only after a container restart.
- Multi-audio WEB-DLs pass the Sonarr and Radarr language checks because English is present, but a foreign track can have the `default` flag. Infuse then plays the foreign track.
- A hardlinked file, or a file that a torrent still seeds, shares its data with qBittorrent. A header edit changes the torrent data, and a qBittorrent recheck downloads those pieces again and undoes the edit.
- Over SSH, `pkill -f <name>` and `ps | grep <name>` can match and stop your own SSH shell, because its command line contains the name.
- YTS clone groups publish fake files with ads in the folder. They show in Radarr as "Unable to determine if file is a sample".
