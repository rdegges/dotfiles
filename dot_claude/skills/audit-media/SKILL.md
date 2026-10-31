---
name: audit-media
description: "Audit the home media library and fix what stops it from working well in Jellyfin, Infuse, and Seerr: file and folder names, audio and subtitle tracks, default-track flags, orphan subtitle files, metadata matches, Seerr sync, Bazarr gaps, and stuck or fake downloads in Sonarr, Radarr, and qBittorrent. Use when the user runs /audit-media, says they downloaded new media, or asks to make sure that the library works in Jellyfin, Infuse, or Seerr. Also cleans up series folders and matches, and finds leftovers of deleted media. Args: none (new media since the last audit), 'all' (whole library), 'series', 'leftovers', or a title or path."
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
- `series`: audit the layout and matches of every series, even when no file changed. See "Series layout" in Step 4.
- `leftovers`: look for media that was deleted but not fully cleaned up. See "Leftovers from deleted media" in Step 4.

A full `all` run includes the `series` and `leftovers` checks.

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
10. For the `series` and `leftovers` checks, also read:
    - Every Sonarr series: path, title, year, TVDB ID, TMDB ID, series type, and episode file counts.
    - Every Radarr movie: path, TMDB ID, and whether it has a file.
    - Every Jellyfin series and movie: path and provider IDs (with a `userId`).
    - The folders at the top level of each library root, and the video count in each folder.
    - The files in the qBittorrent download folders, with sizes and link counts.

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

### Series layout

Sonarr is the source of truth for series. Its series path and its TVDB ID decide the folder and the match. Seerr links a series by its TMDB ID, so the Jellyfin series needs the same TMDB ID as Sonarr.

Examine every series for these faults:

| Fault | What to look for |
|---|---|
| Folder name | The series folder is not `Title (Year)` as Sonarr names it, or it does not agree with the Sonarr series path. Two shows with the same title need the year to tell them apart. |
| Duplicate folders | Two folders hold one series (for example, `Dragonball Z` and `Dragon Ball Z`). Jellyfin then shows two series, and Seerr links to only one. |
| Unmanaged folder | A series folder has no Sonarr series. Sonarr does not upgrade it, and Seerr has no link to delete it. |
| Missing folder | A Sonarr series path does not exist. |
| Loose files | Episode files are at the top of the library root or of the series folder, with no season folder. A series that Sonarr manages with season folders turned off is correct as it is. |
| Wrong library | A series of Sonarr type `anime` is in the shows library, or a `standard` series is in the anime library. The track policy and the metadata source of the library then do not fit. |
| Wrong match | The TVDB or TMDB ID of the Jellyfin series does not agree with the Sonarr series. Jellyfin split one series into two items, or put two series into one item. |
| No TMDB ID | The Jellyfin series has a TVDB ID only. Seerr cannot link it. |
| Seerr link | The series is in Jellyfin but not "available" in Seerr, or Seerr shows it as "available" with no Sonarr link. |

### Leftovers from deleted media

Deleted media can leave data in six places. Examine each one:

| Place | Leftover |
|---|---|
| Library folders | A movie or series folder that holds no video, only sidecars, `.nfo` files, images, or app folders. |
| Sonarr and Radarr | A series or movie whose path does not exist. A monitored item with no file, which Sonarr or Radarr searches for again. Only report it: the user can have deleted it on purpose. |
| Jellyfin | An item whose path does not exist. A library scan usually removes it. |
| Seerr | An item that shows as "available", but Jellyfin has no item with its TMDB ID. |
| qBittorrent | A torrent whose files have a link count of 1 in the download folder, while the hardlinked library copy is gone. It uses disk space for media that is no longer in the library. |
| Download folders | Files or folders that no torrent and no queue item holds. |

Give the size of each leftover, and the total disk space that the cleanup can make free.

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
- **Jellyfin series match from Sonarr.** If the Jellyfin series has a wrong match or no TMDB ID, apply the match with the exact TVDB or TMDB ID that Sonarr has (on Jellyfin: `/Items/RemoteSearch/Apply/{id}`). Do this only when Sonarr gives the ID. Then run the Seerr `jellyfin-full-scan` job.
- **Empty media folders.** Move a library folder that holds no video file to the holding folder. Write each folder in the report.

### Ask before you do these

- Rename or move a media file or folder. Use the Sonarr or Radarr rename function when it manages the item, so that their records stay correct. This includes a subtitle file that is next to its video but has a different base name.
- Delete media, or download it again.
- Fix a series folder. Change the series path in Sonarr with the option that moves the files, so that Sonarr moves the folder and keeps its records. Then use the Sonarr rename function for the episode files. For duplicate folders, first make sure that no episode file is in both folders, and keep the folder that Sonarr manages.
- Add an unmanaged series or movie folder to Sonarr or Radarr. Add it unmonitored and with no search, unless the user says otherwise.
- Move a series to the other library (shows or anime), or change its Sonarr series type.
- Remove a series or movie from Sonarr or Radarr when its path does not exist. Then make sure that Seerr no longer shows it as "available".
- Delete a torrent and its data in qBittorrent, or delete files from a download folder. Give the size of each first.
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
6. After a series fix, make sure that Jellyfin shows one series item with the Sonarr TVDB and TMDB IDs, and that Seerr shows the series as "available" with a Sonarr link.
7. After a leftover cleanup, give the disk space that the cleanup made free.
8. After the Bazarr search is complete, list each file that still has no subtitle in the language of the user. Put it under "Left as is" or "Needs your decision".

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
- A series folder that the user renamed by hand keeps its old path in Sonarr. Sonarr then reports the series as missing and can download it again. Change the path in Sonarr, not only on disk.
- YTS clone groups publish fake files with ads in the folder. They show in Radarr as "Unable to determine if file is a sample".
