# SL Unity Course Wrapper Maker

Cross-platform Electron maker for exporting a Unity WebGL course into Windows, macOS, or dual-platform wrapper folders.

## Workflow

- Import a Unity WebGL build folder or ZIP. It must contain index.html and Unity's Build output; a ZIP may have one enclosing folder.
- The maker suggests a course name from Unity's loader productName or HTML title. Edit the name before export.
- Launch course previews the imported course.
- Build wrapper lets you choose Windows, macOS, or both, then select a parent folder. A Windows-only export is one self-extracting `.exe` containing the Windows app and course. On first launch it extracts to a hash-named folder under the user's temporary directory and starts the course; later launches reuse that extracted copy. A combined export places the Windows `.exe` in `Windows/`. The Mac course is embedded inside the `.app`.
- The generated app launches the embedded course immediately. Pass --oobe to reopen the import screen and replace that wrapper's course.
- The maker always opens its import/export screen; only an exported course wrapper launches a course automatically. Development runs use separate app data so they cannot intercept the installed maker.

The maker installer is lightweight and does not bundle either native shell. When you export, it downloads only the selected Windows and/or universal macOS shell from that version's public GitHub release, checks its SHA-256, and caches it locally for later builds. Both maker editions can create either target. The macOS runtime is universal for Intel and Apple Silicon. When a Windows maker creates a macOS target, it injects the course into the symlink-preserving app ZIP; extract that ZIP into the generated `macOS` folder on a Mac before launching it.

## Run from source

Install dependencies once, then start the maker:

    npm install
    npm start

Open the replacement screen during development:

    npm run start:oobe

## Build the maker installers

    npm run dist:win
    npm run dist:mac

The GitHub Actions release workflow builds Windows and macOS installers and attaches the native runtime archives to each version-tag release. The maker packages contain only the UI and export tools; runtime archives download on demand. The public repository contains the app source and release downloads.

After each release build, keep a local copy of the Windows installer under `dist/releases/<version>/`. Keep the version in the folder name and retain the original release filename so it is easy to locate and reuse without rebuilding.

## Program updates

The packaged maker checks the public GitHub release feed on launch. No account sign-in is required.

When an update is available, choose **Update now** or **Next launch**. Windows downloads the update and offers to restart and install it. macOS checks the release feed and opens the release page; installation remains manual until the app is Developer ID signed and notarized. Exported course wrappers do not check for maker updates; their `--oobe` flow remains for replacing course content.

Release builds include `latest.yml` and blockmaps alongside Windows installer assets for electron-updater. Because this repository and its releases are public, these files contain no private course content or credentials.

## Export and diagnostics

Folder imports use the source in place, avoiding an extra copy inside the maker. ZIP imports are unpacked into the maker's local course cache. Export reports file-level progress while embedding the course into platform archives and packing the Windows self-extracting executable. Export logs are written to the maker's user data directory under `logs/export.log`.

## Technical notes

Unity content is served through a loopback-only HTTP server, avoiding file:// restrictions without exposing content to the LAN. Folder imports are referenced in place; ZIP imports are unpacked into the maker's local course cache.

The pilot installers are unsigned. macOS Gatekeeper may require an override until Developer ID signing and notarization are configured; Windows may show SmartScreen.
